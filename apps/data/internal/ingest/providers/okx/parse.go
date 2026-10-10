package okx

import "strconv"

// cursorI64 reads a cursor field the wire accepts as a ms epoch or row id
// (number or numeric string). Absent/empty cursor keys are simply no window.
func cursorI64(v any) (int64, bool) {
	switch t := v.(type) {
	case string:
		n, err := strconv.ParseInt(t, 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	case float64:
		return int64(t), true
	case int64:
		return t, true
	case int:
		return int64(t), true
	default:
		return 0, false
	}
}
