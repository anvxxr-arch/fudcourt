package binance

import "strconv"

// parseF64 parses a wire number string.
func parseF64(s string) (float64, error) {
	return strconv.ParseFloat(s, 64)
}
