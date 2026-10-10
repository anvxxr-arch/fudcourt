package bi

import "os"

// apiKeyFromEnv reads BI_API_KEY. Kept in its own file so tests can build
// clients with explicit keys without touching the process environment.
func apiKeyFromEnv() string { return os.Getenv("BI_API_KEY") }
