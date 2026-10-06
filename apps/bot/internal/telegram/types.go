// Package telegram is a minimal, stdlib-only client for the subset of the
// Telegram Bot API this service uses: getMe, getUpdates, sendMessage and
// answerCallbackQuery.
//
// It is deliberately hand-rolled rather than a third-party SDK: apps/api
// carries zero external requires (no go.sum), and a bot that only needs four
// methods should not be the module that drags in a dependency graph. The wire
// shapes below mirror the official Bot API types, trimmed to the fields the
// handlers read — an absent field decodes to its zero value, which every caller
// treats as "not present".
package telegram

// User is a Telegram account (a sender or the bot itself).
type User struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
}

// FullName renders a display name for greetings.
func (u User) FullName() string {
	if u.LastName == "" {
		return u.FirstName
	}
	if u.FirstName == "" {
		return u.LastName
	}
	return u.FirstName + " " + u.LastName
}

// Chat identifies the conversation an update belongs to.
type Chat struct {
	ID       int64  `json:"id"`
	Type     string `json:"type"` // private | group | supergroup | channel
	Title    string `json:"title"`
	Username string `json:"username"`
	IsForum  bool   `json:"is_forum"`
}

// Message is a message in a chat. Only the fields the handlers read are kept.
type Message struct {
	MessageID       int64  `json:"message_id"`
	MessageThreadID int64  `json:"message_thread_id"`
	From            *User  `json:"from"`
	Chat            Chat   `json:"chat"`
	Date            int64  `json:"date"`
	Text            string `json:"text"`
	Caption         string `json:"caption"`
}

// CallbackQuery is a press on an inline keyboard button.
type CallbackQuery struct {
	ID      string   `json:"id"`
	From    *User    `json:"from"`
	Message *Message `json:"message"`
	Data    string   `json:"data"`
}

// Update is one delivered event. Exactly one of the payload fields is set.
type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message"`
	EditedMessage *Message       `json:"edited_message"`
	CallbackQuery *CallbackQuery `json:"callback_query"`
}

// EffectiveMessage returns whichever message payload the update carries.
func (u Update) EffectiveMessage() *Message {
	if u.Message != nil {
		return u.Message
	}
	return u.EditedMessage
}

// EffectiveUser returns the user who caused the update, if any.
func (u Update) EffectiveUser() *User {
	if m := u.EffectiveMessage(); m != nil && m.From != nil {
		return m.From
	}
	if u.CallbackQuery != nil {
		return u.CallbackQuery.From
	}
	return nil
}

// apiEnvelope is the uniform Bot API response wrapper.
type apiEnvelope struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
	ErrorCode   int    `json:"error_code"`
	Result      []byte `json:"-"`
}
