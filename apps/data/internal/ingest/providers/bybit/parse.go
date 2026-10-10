package bybit

import "strconv"

// parseI64 parses a wire integer string.
func parseI64(s string) (int64, error) {
	return strconv.ParseInt(s, 10, 64)
}
