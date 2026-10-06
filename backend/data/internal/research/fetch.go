package research

import "net/http"

// Doer is the subset of *http.Client the fetchers use.
type Doer interface {
	Do(*http.Request) (*http.Response, error)
}
