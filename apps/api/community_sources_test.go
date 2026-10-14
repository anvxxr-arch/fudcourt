package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A role-assignment record is the only reason "why didn't this member get the
// role?" is answerable, and it is written by the BOT and accepted by the API.
// That makes `source` a contract with two ends in two languages, so these tests
// hold both of them: the api's own set, and the literals the bot actually sends.

func TestValidateAssignmentAcceptsEveryAssignmentSource(t *testing.T) {
	for _, source := range assignmentSources {
		in := &roleAssignmentInput{UserID: "111111111111111111", RoleID: "222222222222222222", Action: "add", Source: source, Status: "ok"}
		if msg := validateAssignment(in); msg != "" {
			t.Errorf("source %q must be accepted, got refusal %q", source, msg)
		}
	}
}

func TestAssignmentRefusalSentenceNamesEveryAcceptedSource(t *testing.T) {
	sentence := assignmentSourceSentence()
	for _, source := range assignmentSources {
		if !strings.Contains(sentence, source) {
			t.Errorf("refusal sentence %q omits %q: an operator cannot fix a source the message never mentions",
				sentence, source)
		}
	}
	if !strings.HasSuffix(sentence, assignmentSources[len(assignmentSources)-1]) {
		t.Errorf("refusal sentence %q should end with the last accepted source %q",
			sentence, assignmentSources[len(assignmentSources)-1])
	}
}

func TestValidateAssignmentRefusesAnUnknownSource(t *testing.T) {
	in := &roleAssignmentInput{UserID: "111111111111111111", RoleID: "222222222222222222", Action: "add", Source: "panel-reaction2", Status: "ok"}
	msg := validateAssignment(in)
	if msg == "" {
		t.Fatal("an unknown source must be refused")
	}
	if !strings.Contains(msg, "panel-reaction2") && !strings.Contains(msg, "source must be") {
		t.Errorf("refusal %q does not explain the source problem", msg)
	}
}

// botRoleAssignmentSource matches the source argument of a RoleService call:
// `await this.deps.roles.grant(userId, rule.roleId, "autorole")`. It is scoped to
// the `roles.` receiver on purpose — the automod service has an unrelated private
// `apply(fired, {...}, now)` whose arguments carry unrelated string literals, and
// matching that would make this guard lie in the loud direction.
var botRoleAssignmentSource = regexp.MustCompile(`\.roles\.(?:grant|revoke|apply)\([^;]*?"([a-z][a-z-]*)"\s*[,)]`)

// TestBotRoleAssignmentSourcesAreAcceptedByTheApi is the guard that was missing
// when reaction-role grants went unrecorded: the bot sent "panel-reaction", the
// api's set did not have it, and the bot's best-effort recording swallowed the
// 400. Nothing failed; the rows simply were not there.
func TestBotRoleAssignmentSourcesAreAcceptedByTheApi(t *testing.T) {
	root := filepath.Join("..", "discord-bot", "src")
	found := map[string]bool{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".ts") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range botRoleAssignmentSource.FindAllStringSubmatch(string(b), -1) {
			found[m[1]] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scan %s: %v", root, err)
	}

	// Self-check first: a scan that stops matching must FAIL rather than pass on an
	// empty set — that is the difference between a guard and a decoration.
	for _, want := range []string{"autorole", "panel", "panel-reaction", "verification"} {
		if !found[want] {
			t.Fatalf("no %q source found under %s: the extraction pattern no longer matches the bot's call sites", want, root)
		}
	}
	for source := range found {
		if !assignmentSourceSet[source] {
			t.Errorf("the bot records source %q and validateAssignment refuses it: every such attempt is silently absent from role_assignments (add it to assignmentSources, or stop sending it)", source)
		}
	}
}

// TestCaseSourcesCoverTheBotsModerationSources is the same guard for the other
// vocabulary the bot writes into: automod actions reach the moderation service as
// a ModRequest with source "automod" (src/automod/service.ts).
func TestCaseSourcesCoverTheBotsModerationSources(t *testing.T) {
	if !caseSources["automod"] {
		t.Fatal(`caseSources must accept "automod": src/automod/service.ts sends it on every rule action, ` +
			`and a refusal there drops the case for a rule the operator configured`)
	}
}
