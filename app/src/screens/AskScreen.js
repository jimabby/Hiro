// Ask Hiro, on the phone.
//
// The desktop's assistant and its stored conversations, over the paired Wi-Fi
// connection: ask about the job search, or pick one of the résumés saved on the
// desktop, add a job ad, and ask for a review, a match check, a tailored
// version or a cover letter. A full résumé or letter comes back as a card with
// Copy, and with whatever the desktop's fabrication check found in it.
//
// What stays on the desktop: attaching a new file (the phone picks from the
// résumés already saved there), saving a draft as a résumé, downloads, and the
// suggested actions. Every question spends on the desktop's AI key, which is why
// only a paired phone may ask — see the desktop's services/mobileApi.js.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { radius, useTheme } from '../theme'
import { messageFor } from '../requestErrors'
import { splitDrafts, wordCount } from '../chatDrafts'

const RESUME_STARTERS = [
  'Review my résumé: what are the five changes that would help most?',
  'Which of my bullet points are weakest, and how would you rewrite them?',
]
const JOB_STARTERS = [
  'How well does my résumé match this job? Be honest.',
  'Tailor my résumé to this job.',
  'Write a cover letter for this job.',
]
const SEARCH_STARTERS = [
  'What do I need to do this week?',
  'Which applications have gone quiet?',
]

const FLAG_LABELS = { date: 'date', credential: 'qualification', employer: 'employer', 'job-title': 'job title' }

function DraftCard({ draft, check, styles }) {
  const [copied, setCopied] = useState(false)
  const label = draft.kind === 'resume' ? 'Résumé draft' : 'Cover letter draft'
  const flags = check?.flags || []
  async function copy() {
    await Clipboard.setStringAsync(draft.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <View style={styles.draft} accessibilityLabel={label}>
      <View style={styles.draftHead}>
        <Text style={styles.draftTitle}>{label} · {wordCount(draft.text)} words</Text>
        <TouchableOpacity onPress={copy} style={styles.smallButton} accessibilityRole="button" accessibilityLabel={`Copy ${label}`}>
          <Text style={styles.smallButtonText}>{copied ? 'Copied' : 'Copy'}</Text>
        </TouchableOpacity>
      </View>
      {flags.length > 0 && (
        <Text style={styles.flags}>
          Check before using: not in your résumé — {flags.map(f => `${FLAG_LABELS[f.kind] || f.kind} “${f.value}”`).join(', ')}. Keep only if true.
        </Text>
      )}
      <Text style={styles.draftBody} selectable>{draft.text}</Text>
      <Text style={styles.draftFoot}>To save it as a résumé or download it, open this conversation in Ask Hiro on the desktop.</Text>
    </View>
  )
}

function Message({ message, styles }) {
  const isUser = message.role === 'user'
  const checks = (message.actions || []).filter(a => a.type === 'draft')
  const segments = !isUser && !message.error ? splitDrafts(message.content) : [{ type: 'text', text: message.content }]
  return (
    <View style={[styles.messageRow, isUser ? styles.messageRowUser : null]}>
      {segments.map((seg, k) => seg.type === 'draft'
        ? <DraftCard key={k} draft={seg} check={checks[seg.index]} styles={styles} />
        : (
          <View key={k} style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
            <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser, message.error && styles.bubbleError]} selectable>
              {isUser && seg.text.length > 1200 ? `${seg.text.slice(0, 500)}… (${wordCount(seg.text)} words)` : seg.text}
            </Text>
          </View>
        ))}
    </View>
  )
}

export default function AskScreen({ client, active = true }) {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [threads, setThreads] = useState([])
  const [threadId, setThreadId] = useState(null)
  const [messages, setMessages] = useState([])
  const [resumes, setResumes] = useState([])
  // What the conversation is about. `resumeId` is what the phone chose this
  // session; `resumeName` is what the desktop says the thread already has.
  const [resumeId, setResumeId] = useState(undefined)
  const [resumeName, setResumeName] = useState('')
  const [jobText, setJobText] = useState('')
  const [jobChanged, setJobChanged] = useState(false)
  const [jobOpen, setJobOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState('')
  const scrollRef = useRef(null)

  const load = useCallback(async () => {
    if (!client?.canAsk) return
    try {
      const [list, saved] = await Promise.all([client.getAskThreads(), client.getAskResumes()])
      setThreads(Array.isArray(list) ? list : [])
      setResumes(Array.isArray(saved) ? saved : [])
      setUnavailable('')
    } catch (err) {
      if (Number(err.status) === 404) setUnavailable('Update Hiro on the desktop to use Ask Hiro from your phone.')
      else if (Number(err.status) === 403) setUnavailable(err.message)
      else setError(messageFor(err))
    }
  }, [client])

  useEffect(() => { if (active) load() }, [active, load])

  function newConversation() {
    if (busy) return
    setThreadId(null)
    setMessages([])
    setResumeId(undefined)
    setResumeName('')
    setJobText('')
    setJobChanged(false)
    setJobOpen(false)
    setError('')
  }

  async function openThread(id) {
    if (busy) return
    try {
      const t = await client.getAskThread(id)
      setThreadId(t.id)
      setMessages(t.messages || [])
      setResumeId(undefined)
      setResumeName(t.documents?.resumeName || '')
      setJobText(t.documents?.jobText || '')
      setJobChanged(false)
      setJobOpen(false)
      setError('')
    } catch (err) {
      setError(messageFor(err))
    }
  }

  function deleteThread(t) {
    Alert.alert('Delete conversation?', t.title || 'This conversation', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await client.deleteAskThread(t.id)
            if (t.id === threadId) newConversation()
            load()
          } catch (err) { setError(messageFor(err)) }
        },
      },
    ])
  }

  function chooseResume(r) {
    setResumeId(r ? r.id : '')
    setResumeName(r ? r.name : '')
  }

  async function send(text) {
    const question = String(text ?? input).trim()
    if (!question || busy) return
    setMessages(prev => [...prev, { role: 'user', content: question }])
    setInput('')
    setError('')
    setBusy(true)
    try {
      const res = await client.ask({
        question, threadId,
        ...(resumeId !== undefined ? { resumeId } : {}),
        ...(jobChanged ? { jobText } : {}),
      })
      if (res?.threadId) setThreadId(res.threadId)
      setMessages(prev => [...prev, { role: 'assistant', content: res.reply, actions: res.actions || [] }])
      // Sent once; the desktop keeps it with the thread from here on.
      setResumeId(undefined)
      setJobChanged(false)
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: err.timeout ? 'No answer within three minutes. The desktop may still finish it — reopen this conversation in a moment.' : messageFor(err), error: true }])
    } finally {
      setBusy(false)
      load()
    }
  }

  if (!client?.canAsk) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.title}>Ask Hiro</Text>
        <Text style={styles.muted}>Ask Hiro works when your phone is paired with the desktop over Wi-Fi. Connect on the same network as the desktop to use it.</Text>
      </View>
    )
  }
  if (unavailable) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.title}>Ask Hiro</Text>
        <Text style={styles.muted}>{unavailable}</Text>
      </View>
    )
  }

  const hasJob = !!jobText.trim()
  const starters = hasJob ? JOB_STARTERS : resumeName ? RESUME_STARTERS : SEARCH_STARTERS

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.title}>Ask Hiro</Text>
        <TouchableOpacity onPress={newConversation} style={styles.smallButton} accessibilityRole="button" disabled={busy}>
          <Text style={styles.smallButtonText}>New</Text>
        </TouchableOpacity>
      </View>

      {threads.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.threadStrip} contentContainerStyle={styles.chipRow}>
          {threads.slice(0, 20).map(t => (
            <TouchableOpacity key={t.id} onPress={() => openThread(t.id)} onLongPress={() => deleteThread(t)}
              style={[styles.chip, t.id === threadId && styles.chipActive]} accessibilityRole="button"
              accessibilityLabel={`Conversation: ${t.title}`} accessibilityHint="Long-press to delete">
              <Text numberOfLines={1} style={[styles.chipText, t.id === threadId && styles.chipTextActive]}>{t.has_resume ? '📄 ' : ''}{t.title || 'Conversation'}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={styles.messagesContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd?.({ animated: true })} keyboardShouldPersistTaps="handled">
        {messages.length === 0 && (
          <View>
            <Text style={styles.sectionHead}>Résumé</Text>
            {resumes.length === 0
              ? <Text style={styles.muted}>Add a résumé on the desktop (Settings → Resumes, or attach one in Ask Hiro there) to get help with it here.</Text>
              : (
                <View style={styles.chipWrap}>
                  <TouchableOpacity onPress={() => chooseResume(null)} style={[styles.chip, !resumeName && styles.chipActive]} accessibilityRole="button">
                    <Text style={[styles.chipText, !resumeName && styles.chipTextActive]}>None</Text>
                  </TouchableOpacity>
                  {resumes.map(r => (
                    <TouchableOpacity key={r.id} onPress={() => chooseResume(r)} style={[styles.chip, resumeName === r.name && styles.chipActive]}
                      accessibilityRole="button" accessibilityState={{ selected: resumeName === r.name }}>
                      <Text style={[styles.chipText, resumeName === r.name && styles.chipTextActive]}>{r.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            <Text style={styles.sectionHead}>Try asking</Text>
            {starters.map(s => (
              <TouchableOpacity key={s} onPress={() => send(s)} style={styles.starter} accessibilityRole="button">
                <Text style={styles.starterText}>{s}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {messages.map((m, i) => <Message key={m.id ?? `local-${i}`} message={m} styles={styles} />)}
        {busy && (
          <View style={styles.thinking}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.muted}>  Hiro is writing… a full résumé can take a minute.</Text>
          </View>
        )}
        {!!error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>

      <View style={styles.contextBar}>
        <Text style={styles.contextText} numberOfLines={1}>
          {resumeName ? `📄 ${resumeName}` : 'No résumé'}{hasJob ? ` · 💼 Job ad (${wordCount(jobText)} words)` : ''}
        </Text>
        <TouchableOpacity onPress={() => setJobOpen(o => !o)} style={styles.smallButton} accessibilityRole="button">
          <Text style={styles.smallButtonText}>{jobOpen ? 'Done' : hasJob ? 'Edit job ad' : '+ Job ad'}</Text>
        </TouchableOpacity>
      </View>
      {jobOpen && (
        <TextInput value={jobText} onChangeText={t => { setJobText(t); setJobChanged(true) }} multiline
          placeholder="Paste the job ad here" placeholderTextColor={colors.textFaint}
          style={[styles.input, styles.jobInput]} accessibilityLabel="Job ad" maxLength={40000} />
      )}
      <View style={styles.composer}>
        <TextInput value={input} onChangeText={setInput} multiline placeholder={resumeName ? 'Ask about your résumé…' : 'Ask anything…'}
          placeholderTextColor={colors.textFaint} style={[styles.input, styles.composerInput]} accessibilityLabel="Ask Hiro a question" maxLength={20000} />
        <TouchableOpacity onPress={() => send()} disabled={busy || !input.trim()} style={[styles.send, (busy || !input.trim()) && styles.sendDisabled]}
          accessibilityRole="button" accessibilityLabel="Send">
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  centered: { padding: 24, justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 },
  title: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 6 },
  muted: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
  error: { color: c.red, fontSize: 13, marginTop: 8 },
  sectionHead: { color: c.textMuted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 10, marginBottom: 8 },

  threadStrip: { flexGrow: 0, maxHeight: 48 },
  chipRow: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, maxWidth: 220, minHeight: 36, justifyContent: 'center' },
  chipActive: { backgroundColor: c.accent, borderColor: c.accent },
  chipText: { color: c.text, fontSize: 13 },
  chipTextActive: { color: '#fff', fontWeight: '600' },

  messages: { flex: 1 },
  messagesContent: { padding: 16, paddingBottom: 24, gap: 10 },
  starter: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius, padding: 12, marginBottom: 8, minHeight: 44, justifyContent: 'center' },
  starterText: { color: c.text, fontSize: 14 },

  messageRow: { alignItems: 'flex-start', gap: 6 },
  messageRowUser: { alignItems: 'flex-end' },
  bubble: { borderRadius: radius, paddingHorizontal: 12, paddingVertical: 9, maxWidth: '88%' },
  bubbleUser: { backgroundColor: c.accent },
  bubbleAssistant: { backgroundColor: c.surface2 },
  bubbleText: { color: c.text, fontSize: 14.5, lineHeight: 21 },
  bubbleTextUser: { color: '#fff' },
  bubbleError: { color: c.red },

  draft: { alignSelf: 'stretch', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius, overflow: 'hidden' },
  draftHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  draftTitle: { color: c.text, fontSize: 13, fontWeight: '600', flex: 1 },
  draftBody: { color: c.text, fontSize: 13.5, lineHeight: 20, padding: 12 },
  draftFoot: { color: c.textFaint, fontSize: 11.5, paddingHorizontal: 12, paddingBottom: 10 },
  flags: { color: c.yellow, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 12, paddingTop: 10 },

  thinking: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },

  contextBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.border },
  contextText: { color: c.textMuted, fontSize: 12.5, flex: 1 },
  smallButton: { borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, minHeight: 34, justifyContent: 'center' },
  smallButtonText: { color: c.accent, fontSize: 13, fontWeight: '600' },

  input: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius, color: c.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
  jobInput: { marginHorizontal: 16, marginBottom: 6, maxHeight: 160, minHeight: 80, textAlignVertical: 'top' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 16, paddingBottom: 10, paddingTop: 4 },
  composerInput: { flex: 1, maxHeight: 140, minHeight: 44 },
  send: { backgroundColor: c.accent, borderRadius: radius, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: '#fff', fontSize: 15, fontWeight: '600' },
})
