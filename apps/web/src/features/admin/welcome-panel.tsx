'use client';

import { useCallback, useEffect, useState } from 'react';
import { fontFamily, fontSize, fontWeight, lineHeight, radius, space, themeColor } from '@/styles/tokens';
import { fetchWelcome, saveWelcome, type WelcomeConfig } from './client';
import { describeSaveFailure } from './save-error';
import {
  EMBED_HINT,
  MAX_MESSAGE,
  STARTER_JOIN,
  STARTER_LEAVE,
  VARIABLES,
  adoptedNote,
  fromConfig,
  runeCount,
  sampleFrom,
  toConfig,
  type WelcomeDraft,
} from './welcome-draft';
import {
  colorHex,
  joinPreview,
  leavePreview,
  type DirectionPreview,
  type PreviewEmbed,
  type PreviewPayload,
  type SampleMember,
} from './welcome-template';

// WelcomePanel edits the welcome/goodbye config and PREVIEWS it.
//
// The preview is the point. Every other panel in this dashboard edits values whose meaning is
// visible in the field; this one edits a TEMPLATE, and a template's meaning is only visible once
// it is rendered with a member in it. `welcome-template.ts` mirrors the bot's engine so what is
// shown here is what will actually be posted, including the two facts an operator cannot see from
// the form:
//   • a blank message with an empty embed posts NOTHING — the bot skips an empty payload;
//   • a join DM carries the SAME embed as the channel post, because the bot passes one embed to
//     both sends.
//
// The panel also does NOT own validation. The api refuses a blank channel, an over-long message and
// a mistyped embed field, and its sentence names the field — so the panel shows it. The single
// local refusal is JSON syntax, which cannot be sent at all.
//
// One behaviour worth knowing while reading this file: the api FORCES `joinEnabled` off when the
// channel is blank, because a join message with nowhere to go is a silent no-op that looks like a
// bug. Save therefore adopts the config the server returns, and says so when it differs.

const inputStyle: React.CSSProperties = {
  background: themeColor.bgBase,
  color: themeColor.labelPrimary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[6]}px`,
  fontSize: fontSize[13],
  fontFamily: 'inherit',
};

const areaStyle: React.CSSProperties = { ...inputStyle, minHeight: 78, resize: 'vertical', lineHeight: lineHeight.normal };

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  color: themeColor.blue,
  border: `1px solid ${themeColor.blue}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[10]}px`,
  fontSize: fontSize[12],
  cursor: 'pointer',
};

const btnPrimary: React.CSSProperties = { ...btnStyle, background: themeColor.blue, color: themeColor.labelOnAccent };

const noteStyle: React.CSSProperties = { fontSize: fontSize[12], color: themeColor.labelSecondary };

function label(text: string, tone: 'primary' | 'tertiary' = 'tertiary'): React.CSSProperties {
  return { color: tone === 'tertiary' ? themeColor.labelTertiary : themeColor.labelSecondary, fontSize: fontSize[11] };
}

function Field({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 140 }}>
      <span style={label(title)}>{title}</span>
      {children}
      {hint !== undefined && <span style={label(hint)}>{hint}</span>}
    </label>
  );
}

function Check({ title, hint, checked, onChange }: { title: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: space[8], cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ ...label(title, 'primary'), fontSize: fontSize[13] }}>{title}</span>
        {hint !== undefined && <span style={label(hint)}>{hint}</span>}
      </span>
    </label>
  );
}

/** EmbedCard draws the embed the way Discord would, so colour and structure are visible at a
 *  glance. It is an approximation — Discord's own spacing is not the point — but the fields it
 *  shows are exactly the ones the bot sends, because the renderer already dropped the rest. */
function EmbedCard({ embed }: { embed: PreviewEmbed }) {
  return (
    <div
      style={{
        background: themeColor.bgSecondary,
        borderLeft: `4px solid ${embed.color === undefined ? themeColor.separator : colorHex(embed.color)}`,
        borderRadius: radius[8],
        padding: `${space[8]}px ${space[12]}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: space[4],
        maxWidth: 480,
      }}
    >
      {embed.author?.name !== undefined && <span style={label(embed.author.name)}>{embed.author.name}</span>}
      {embed.title !== undefined && <span style={{ color: themeColor.blue, fontSize: fontSize[13], fontWeight: fontWeight.semibold }}>{embed.title}</span>}
      {embed.description !== undefined && <span style={{ ...noteStyle, whiteSpace: 'pre-wrap' }}>{embed.description}</span>}
      {embed.fields?.map((f, i) => (
        <span key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ ...label(f.name, 'primary'), fontSize: fontSize[12], fontWeight: fontWeight.semibold }}>{f.name}</span>
          <span style={{ ...noteStyle, whiteSpace: 'pre-wrap' }}>{f.value}</span>
        </span>
      ))}
      {embed.thumbnail?.url !== undefined && <span style={label(`thumbnail: ${embed.thumbnail.url}`)} />}
      {embed.image?.url !== undefined && <span style={label(`image: ${embed.image.url}`)} />}
      {embed.footer?.text !== undefined && <span style={label(embed.footer.text)}>{embed.footer.text}</span>}
    </div>
  );
}

function PayloadCard({ what, payload }: { what: string; payload: PreviewPayload }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
      <span style={label(what, 'primary')}>{what}</span>
      {payload.content !== undefined && (
        <span style={{ ...noteStyle, color: themeColor.labelPrimary, whiteSpace: 'pre-wrap', maxWidth: 480 }}>{payload.content}</span>
      )}
      {payload.embed !== undefined && <EmbedCard embed={payload.embed} />}
    </div>
  );
}

/** PreviewBox is the answer to "what will this actually do?", including when the answer is
 *  "nothing" — which is a state an operator must be told about, not left to infer from a full
 *  form. */
function PreviewBox({ preview }: { preview: DirectionPreview }) {
  return (
    <div
      style={{
        background: themeColor.bgBase,
        border: `1px solid ${themeColor.separator}`,
        borderRadius: radius[8],
        padding: space[12],
        display: 'flex',
        flexDirection: 'column',
        gap: space[8],
      }}
    >
      <span style={label('preview — what the bot would send')}>preview — what the bot would send</span>
      {preview.embedError !== undefined && <span style={{ ...noteStyle, color: themeColor.red }}>{preview.embedError}</span>}
      {preview.silent !== undefined && <span style={{ ...noteStyle, color: themeColor.orange }}>{preview.silent}</span>}
      {preview.post !== undefined && <PayloadCard what="channel post" payload={preview.post} />}
      {preview.post === undefined && preview.postAbsent !== undefined && preview.silent === undefined && (
        <span style={label(`no channel post — ${preview.postAbsent}`)} />
      )}
      {preview.dm !== undefined && <PayloadCard what="direct message" payload={preview.dm} />}
      {preview.dm === undefined && preview.dmAbsent !== undefined && preview.silent === undefined && (
        <span style={label(`no direct message — ${preview.dmAbsent}`)} />
      )}
    </div>
  );
}

export default function WelcomePanel() {
  const [draft, setDraft] = useState<WelcomeDraft>(() => fromConfig(null));
  const [sample, setSample] = useState<SampleMember>(() => sampleFrom());
  const [stored, setStored] = useState<WelcomeConfig | null>(null);
  const [readError, setReadError] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const view = await fetchWelcome();
      const config = view.welcome ?? null;
      setStored(config);
      setDraft(fromConfig(config));
      setReadError('');
    } catch (err) {
      setReadError(err instanceof Error ? err.message : 'could not read the welcome config');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(<K extends keyof WelcomeDraft>(key: K, value: WelcomeDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setNote(null);
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const built = toConfig(draft);
      if (built.config === undefined) {
        // Nothing is sent: the api would refuse the same text, and saying so here is the same rule
        // rather than a second opinion about it.
        setNote({ ok: false, text: built.embedError ?? 'the embed text cannot be parsed' });
        return;
      }
      const view = await saveWelcome(built.config);
      const saved = view.welcome ?? null;
      if (saved !== null) {
        setStored(saved);
        setDraft(fromConfig(saved));
        setNote({ ok: true, text: adoptedNote(built.config, saved) ?? 'saved' });
      } else {
        setStored(built.config);
        setNote({ ok: true, text: 'saved' });
      }
    } catch (err) {
      setNote({ ok: false, text: describeSaveFailure(err) });
    } finally {
      setBusy(false);
    }
  }, [draft]);

  const join = joinPreview(
    { enabled: draft.joinEnabled, channelId: draft.joinChannelId, message: draft.joinMessage, embedText: draft.joinEmbedText, dm: draft.joinDm, dmMessage: draft.joinDmMessage },
    sample,
  );
  const leave = leavePreview(
    { enabled: draft.leaveEnabled, channelId: draft.leaveChannelId, message: draft.leaveMessage, embedText: draft.leaveEmbedText },
    sample,
  );

  const joinCount = runeCount(draft.joinMessage);
  const leaveCount = runeCount(draft.leaveMessage);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[16] }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space[12], flexWrap: 'wrap' }}>
        <button style={busy ? { ...btnPrimary, opacity: 0.6 } : btnPrimary} onClick={() => void save()} disabled={busy}>
          {busy ? 'saving…' : 'Save welcome & goodbye'}
        </button>
        <span style={label(stored === null ? 'nothing stored yet — the form below is where it starts' : 'stored')} />
        {note !== null && (
          <span style={{ ...noteStyle, color: note.ok ? themeColor.green : themeColor.red }}>{note.text}</span>
        )}
        {readError !== '' && <span style={{ ...noteStyle, color: themeColor.red }}>{readError}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
        <span style={label('preview member — the facts the variables resolve to', 'primary')} />
        <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap' }}>
          <Field title="username">
            <input style={inputStyle} value={sample.username} onChange={(e) => setSample({ ...sample, username: e.target.value, displayName: e.target.value })} />
          </Field>
          <Field title="nickname" hint="falls back to the username when blank">
            <input style={inputStyle} value={sample.displayName} onChange={(e) => setSample({ ...sample, displayName: e.target.value })} />
          </Field>
          <Field title="user id" hint="the snowflake the preview derives the creation date from">
            <input style={inputStyle} value={sample.userId} onChange={(e) => setSample({ ...sample, userId: e.target.value })} />
          </Field>
          <Field title="server">
            <input style={inputStyle} value={sample.guildName} onChange={(e) => setSample({ ...sample, guildName: e.target.value })} />
          </Field>
          <Field title="member count">
            <input style={inputStyle} type="number" min={0} value={sample.memberCount} onChange={(e) => setSample({ ...sample, memberCount: e.target.value })} />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap' }}>
          {VARIABLES.map((v) => (
            <span key={v.name} style={label('')}>
              <code style={{ color: themeColor.blue, fontSize: fontSize[12] }}>{v.name}</code> {v.renders}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: space[12] }}>
        <span style={{ ...label('welcome (join)', 'primary'), fontSize: fontSize[15] }}>welcome (join)</span>
        <Check
          title="send a welcome when a member joins"
          hint="with no channel set this switches itself off when you save"
          checked={draft.joinEnabled}
          onChange={(v) => patch('joinEnabled', v)}
        />
        <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap' }}>
          <Field title="channel id">
            <input style={inputStyle} value={draft.joinChannelId} onChange={(e) => patch('joinChannelId', e.target.value)} />
          </Field>
          <Check
            title="also DM the new member"
            hint="the DM carries the same embed as the channel post"
            checked={draft.joinDm}
            onChange={(v) => patch('joinDm', v)}
          />
        </div>
        <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: space[4], flex: '1 1 380px' }}>
            <span style={label('message')}>{`message — ${joinCount}/${MAX_MESSAGE} characters`}</span>
            <textarea style={areaStyle} value={draft.joinMessage} onChange={(e) => patch('joinMessage', e.target.value)} />
          </label>
          <button style={btnStyle} onClick={() => patch('joinMessage', STARTER_JOIN)}>
            use a starter
          </button>
        </div>
        <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: space[4], flex: '1 1 380px' }}>
            <span style={label('direct message')}>{`direct message — ${runeCount(draft.joinDmMessage)}/${MAX_MESSAGE}`}</span>
            <textarea style={areaStyle} value={draft.joinDmMessage} onChange={(e) => patch('joinDmMessage', e.target.value)} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: space[4], flex: '1 1 380px' }}>
            <span style={label('embed')}>{EMBED_HINT}</span>
            <textarea style={{ ...areaStyle, fontFamily: fontFamily.mono }} value={draft.joinEmbedText} onChange={(e) => patch('joinEmbedText', e.target.value)} />
          </label>
        </div>
        <PreviewBox preview={join} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: space[12] }}>
        <span style={{ ...label('goodbye (leave)', 'primary'), fontSize: fontSize[15] }}>goodbye (leave)</span>
        <Check
          title="send a goodbye when a member leaves"
          hint="there is no goodbye DM: a member who left cannot be reached"
          checked={draft.leaveEnabled}
          onChange={(v) => patch('leaveEnabled', v)}
        />
        <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap' }}>
          <Field title="channel id">
            <input style={inputStyle} value={draft.leaveChannelId} onChange={(e) => patch('leaveChannelId', e.target.value)} />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: space[4], flex: '1 1 380px' }}>
            <span style={label('message')}>{`message — ${leaveCount}/${MAX_MESSAGE} characters`}</span>
            <textarea style={areaStyle} value={draft.leaveMessage} onChange={(e) => patch('leaveMessage', e.target.value)} />
          </label>
          <button style={btnStyle} onClick={() => patch('leaveMessage', STARTER_LEAVE)}>
            use a starter
          </button>
        </div>
        <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: space[4], flex: '1 1 380px' }}>
            <span style={label('embed')}>{EMBED_HINT}</span>
            <textarea style={{ ...areaStyle, fontFamily: fontFamily.mono }} value={draft.leaveEmbedText} onChange={(e) => patch('leaveEmbedText', e.target.value)} />
          </label>
        </div>
        <PreviewBox preview={leave} />
      </div>
    </div>
  );
}
