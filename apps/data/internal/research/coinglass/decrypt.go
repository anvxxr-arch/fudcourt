// Package coinglass is the CoinGlass futures-data family: the keyless
// AES-128-ECB decryptor, the plain net/http fetcher, and the JSON envelope.
//
// # Why there is NO API key here (the whole point of the family)
//
// CoinGlass ships two surfaces (docs/architecture/coinglass-source-recon.md):
//
//	open-api-v4.coinglass.com  -> documented REST V4, needs a human-issued
//	                              `CG-API-KEY`; answers 200 {"code":"401"} without it
//	capi.coinglass.com         -> the dashboard's OWN backend; NO key, and the
//	fapi.coinglass.com            "anti-bot" is that the body is encrypted
//
// The second surface is the one this family uses, and it is strictly a
// reverse-engineering result: there is no key to obtain, because the dashboard's
// browser bundle derives everything it needs from public inputs. Buying a key is
// therefore not an alternative path -- it is a different product with different
// coverage.
//
// # The scheme (measured live 2026-10-02, and it ROTATES)
//
// Two rounds of AES-128-ECB with PKCS#7 padding, each gzip-compressed:
//
//	Key0       = base64(<by_v>) [:16]                       // 16 ASCII chars
//	actual_key = gunzip( AES-128-ECB(b64(user_header), Key0) )    // 16-char hex
//	json       = gunzip( AES-128-ECB(b64(body.data), actual_key) )
//
// `by_v` is chosen by the response's `v` header, which ROTATES per request --
// this recording saw v=77, then v=55, then v=66 across three consecutive calls
// to the same endpoint, so the full table is mandatory:
//
//	v=0   request header  cache-ts-v2
//	v=1   the request URL's PATH (not the full URL, not the query string)
//	v=2   response header time
//	v=55  constant 170b070da9654622
//	v=66  constant d6537d845a964081
//	v=77  constant 863f08689c97435b
//
// A public Python tool implements only v=1 and documents 55/66/77 as
// "deprecated, no longer in use". That claim is WRONG: three live endpoints
// today returned v=66, v=55, v=55 and later v=77, v=55, v=66. An implementation
// that assumes v=1 decrypts nothing -- the failure is a padding error, which
// reads like a broken key rather than a missing case. Hence decrypt_test.go
// pins ALL of 55/66/77 against recorded live fixtures.
//
// # No silence
//
// Missing `v`/`user` means the endpoint answered PLAIN JSON (upstream mixes the
// two: an unencrypted 200 carrying {"code":"40001","msg":"Required Integer
// parameter 'pageNum' is not present"} is CoinGlass telling the truth about a
// bad request). That passes through unchanged -- it is never an empty envelope.
// A body whose `data` is a STRING while `v`/`user` are absent is an error, not a
// passthrough: that shape means encryption we failed to detect.
package coinglass

import (
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
)

// Header names, as measured. `v` and `user` are exposed to JS deliberately --
// the dashboard reads them -- so they arrive on a normal CORS response
// (access-control-expose-headers: user,encryption,language,time,v).
const (
	HeaderV          = "v"
	HeaderUser       = "user"
	HeaderEncryption = "encryption"
	HeaderTime       = "time"
	HeaderCacheTS    = "cache-ts-v2"
)

// legacyKey is the constant table for v=55/66/77. These are values from the
// dashboard's public webpack bundle (module 12471), not secrets: they ship to
// every browser. They are still not credentials for anything -- they only
// decode a public market-data payload.
var legacyKey = map[string]string{
	"55": "170b070da9654622",
	"66": "d6537d845a964081",
	"77": "863f08689c97435b",
}

// KnownV reports whether v is one the table can derive a Key0 for.
func KnownV(v string) bool {
	switch v {
	case "0", "1", "2":
		return true
	}
	_, ok := legacyKey[v]
	return ok
}

// ErrMissingDerivationInput means the `v` header named an input we were not
// given (e.g. v=0 without cache-ts-v2). It is loud on purpose: guessing would
// yield a padding error and mislead the next reader.
var ErrMissingDerivationInput = errors.New("coinglass: v requires an input we were not given")

// Key0 derives the first-layer key from the `v` header.
//
// rawURL is only consulted for v=1 and only its PATH is used: the public
// reference implementation passes the whole URL, which yields the same key only
// because the path happens to be long enough for [:16] to land inside it. Using
// the path explicitly is the correct reading of the bundle.
func Key0(v, rawURL, cacheTS, timeHeader string) (string, error) {
	var constant string
	switch v {
	case "0":
		if cacheTS == "" {
			return "", fmt.Errorf("%w: v=0 needs the %s request header", ErrMissingDerivationInput, HeaderCacheTS)
		}
		constant = cacheTS
	case "1":
		u, err := url.Parse(rawURL)
		if err != nil || u.Path == "" {
			return "", fmt.Errorf("%w: v=1 needs a URL with a path (got %q)", ErrMissingDerivationInput, rawURL)
		}
		constant = u.Path
	case "2":
		if timeHeader == "" {
			return "", fmt.Errorf("%w: v=2 needs the %s response header", ErrMissingDerivationInput, HeaderTime)
		}
		constant = timeHeader
	default:
		c, ok := legacyKey[v]
		if !ok {
			return "", fmt.Errorf("coinglass: unknown v=%q (known: 0,1,2,55,66,77)", v)
		}
		constant = c
	}
	enc := base64.StdEncoding.EncodeToString([]byte(constant))
	if len(enc) < 16 {
		return "", fmt.Errorf("coinglass: derived key0 is only %d chars, need 16", len(enc))
	}
	return enc[:16], nil
}

// ecbDecrypt runs AES in ECB mode, one block at a time.
//
// crypto/cipher deliberately ships no ECB helper (ECB is not a safe mode for
// real cryptography). CoinGlass uses it anyway -- the payload is public market
// data, and ECB's weakness costs them nothing here -- so the loop is written
// out rather than reached for from a dependency.
func ecbDecrypt(block cipher.Block, dst, src []byte) {
	bs := block.BlockSize()
	for len(src) >= bs {
		block.Decrypt(dst[:bs], src[:bs])
		src = src[bs:]
		dst = dst[bs:]
	}
}

// aesECBDecrypt decrypts one AES-128-ECB block chain and strips PKCS#7 padding.
//
// The padding strip is not optional and is the single most common way to get
// this scheme wrong: without it the plaintext still carries 1..16 trailing pad
// bytes, gzip then fails on the trailing garbage, and the error looks like a bad
// key rather than a missing step.
func aesECBDecrypt(ct, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("coinglass: aes key: %w", err)
	}
	if len(ct) == 0 || len(ct)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("coinglass: ciphertext length %d is not a multiple of %d", len(ct), aes.BlockSize)
	}
	out := make([]byte, len(ct))
	ecbDecrypt(block, out, ct)

	pad := int(out[len(out)-1])
	if pad == 0 || pad > aes.BlockSize || pad > len(out) {
		return nil, fmt.Errorf("coinglass: bad PKCS#7 padding byte %d", pad)
	}
	for _, b := range out[len(out)-pad:] {
		if int(b) != pad {
			return nil, errors.New("coinglass: inconsistent PKCS#7 padding")
		}
	}
	return out[:len(out)-pad], nil
}

// gunzip inflates b. A payload that is not gzipped is an error: the scheme
// always compresses, so a silent fallback would hide a wrong key behind
// garbage that later fails somewhere less diagnosable.
func gunzip(b []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("coinglass: gunzip: %w", err)
	}
	defer zr.Close()
	out, err := io.ReadAll(zr)
	if err != nil {
		return nil, fmt.Errorf("coinglass: gunzip read: %w", err)
	}
	return out, nil
}

// b64 decodes a padded or unpadded standard-alphabet base64 string. The `user`
// header arrives without padding (base64url-ish trimming is done by the server),
// so padding is restored rather than assumed.
func b64(s string) ([]byte, error) {
	s = trimSpace(s)
	if m := len(s) % 4; m != 0 {
		s += string(bytes.Repeat([]byte{'='}, 4-m))
	}
	out, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("coinglass: base64: %w", err)
	}
	return out, nil
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\n' || s[start] == '\r' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\n' || s[end-1] == '\r' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

// Envelope is CoinGlass's wire shape on both surfaces.
type Envelope struct {
	Code    string          `json:"code"`
	Msg     string          `json:"msg"`
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
}

// Result is what Decrypt returns.
type Result struct {
	// JSON is the plaintext payload (`data`, unwrapped): what a caller shapes.
	JSON json.RawMessage
	// Encrypted reports whether the two AES layers actually ran. A false value
	// means upstream answered plain JSON and JSON is its `data` verbatim.
	Encrypted bool
	// V is the `v` header the response carried ("" when unencrypted).
	V string
	// Code/Msg are upstream's envelope fields, preserved so a caller can
	// surface an upstream refusal instead of inventing an empty table.
	Code string
	Msg  string
	// Success is upstream's own verdict. A false value with a `null` JSON is
	// CoinGlass refusing the request (measured: a missing `pageNum` answers
	// {"code":"40001","msg":"Required Integer parameter 'pageNum' is not
	// present","success":false}) — a real answer that must not be rendered as
	// an empty table.
	Success bool
}

// Refused reports whether upstream answered a well-formed envelope that says
// "no" — a refusal the caller must surface, never an empty result.
func (r Result) Refused() bool { return !r.Success || (r.Code != "" && r.Code != "0") }

// Decrypt unwraps a CoinGlass response body.
//
// rawBody is the whole HTTP body; user/v/timeHeader come from the response
// headers; rawURL and cacheTS are inputs for the v=0/1/2 derivations.
//
// Unencrypted responses pass through: JSON is `data` and Encrypted is false.
// A response that carries an encrypted-looking `data` STRING but no `v`/`user`
// header is an error -- never a passthrough and never an empty success.
func Decrypt(rawBody []byte, user, v, rawURL, cacheTS, timeHeader string) (Result, error) {
	var env Envelope
	if err := json.Unmarshal(rawBody, &env); err != nil {
		return Result{}, fmt.Errorf("coinglass: envelope: %w", err)
	}

	data := bytes.TrimSpace(env.Data)
	if len(data) == 0 || string(data) == "null" {
		// Upstream said nothing. Report that fact; the caller decides whether
		// it is an error. We never substitute an empty object here.
		return Result{JSON: json.RawMessage("null"), Code: env.Code, Msg: env.Msg, Success: env.Success}, nil
	}

	if data[0] != '"' {
		// Plain JSON payload (objects, arrays, numbers).
		return Result{JSON: data, Code: env.Code, Msg: env.Msg, Success: env.Success}, nil
	}

	var cipherTextB64 string
	if err := json.Unmarshal(data, &cipherTextB64); err != nil {
		return Result{}, fmt.Errorf("coinglass: data string: %w", err)
	}
	if user == "" || v == "" {
		return Result{}, fmt.Errorf("coinglass: body carries an encrypted `data` string but the response has no %s/%s header (v=%q user_len=%d)",
			HeaderV, HeaderUser, v, len(user))
	}

	k0, err := Key0(v, rawURL, cacheTS, timeHeader)
	if err != nil {
		return Result{}, err
	}
	tok, err := b64(user)
	if err != nil {
		return Result{}, fmt.Errorf("coinglass: user header: %w", err)
	}
	step1, err := aesECBDecrypt(tok, []byte(k0))
	if err != nil {
		return Result{}, fmt.Errorf("coinglass: layer 1 (v=%s key0=%s): %w", v, k0, err)
	}
	keyBytes, err := gunzip(step1)
	if err != nil {
		return Result{}, fmt.Errorf("coinglass: layer 1 gunzip (v=%s): %w", v, err)
	}
	actualKey := string(keyBytes)
	if len(actualKey) != 16 {
		return Result{}, fmt.Errorf("coinglass: recovered key is %d chars, want 16 (%q)", len(actualKey), actualKey)
	}

	payload, err := b64(cipherTextB64)
	if err != nil {
		return Result{}, fmt.Errorf("coinglass: body data: %w", err)
	}
	step2, err := aesECBDecrypt(payload, []byte(actualKey))
	if err != nil {
		return Result{}, fmt.Errorf("coinglass: layer 2 (v=%s): %w", v, err)
	}
	plain, err := gunzip(step2)
	if err != nil {
		return Result{}, fmt.Errorf("coinglass: layer 2 gunzip (v=%s): %w", v, err)
	}
	trimmed := bytes.TrimSpace(plain)
	if !json.Valid(trimmed) {
		return Result{}, errors.New("coinglass: decrypted payload is not valid JSON")
	}
	return Result{JSON: trimmed, Encrypted: true, V: v, Code: env.Code, Msg: env.Msg, Success: env.Success}, nil
}
