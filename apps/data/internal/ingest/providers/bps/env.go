package bps

import "os"

// apiKeyFromEnv / apiIDFromEnv read the BPS key pair. Kept in their own file
// so tests can build clients with explicit keys without touching the process
// environment.
func apiKeyFromEnv() string { return os.Getenv("BPS_API_KEY") }

func apiIDFromEnv() string { return os.Getenv("BPS_API_ID") }
