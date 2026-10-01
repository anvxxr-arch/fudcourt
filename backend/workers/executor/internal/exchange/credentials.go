package exchange

// Credentials is the credential HANDLE passed to adapters (house rule:
// adapters receive a credential handle — plaintext secret material is used
// only inside signing helpers and MUST NEVER appear in errors, logs, metrics
// or VenueError fields; raw venue bodies are likewise never rendered).
type Credentials struct {
	// APIKey is the venue API key identifier (public half).
	APIKey string
	// APISecret is the HMAC signing secret. It has no display form at all.
	APISecret string
}

// Masked returns the display form of the API key (PRD §109), mirroring
// types.ts maskApiKey exactly: keys of 8 characters or fewer render as "***",
// longer keys as first3 + "..." + last3. The secret is never rendered.
func (c Credentials) Masked() string {
	return MaskAPIKey(c.APIKey)
}

// MaskAPIKey masks an API key for display (types.ts maskApiKey).
func MaskAPIKey(key string) string {
	if len(key) <= 8 {
		return "***"
	}
	return key[:3] + "..." + key[len(key)-3:]
}
