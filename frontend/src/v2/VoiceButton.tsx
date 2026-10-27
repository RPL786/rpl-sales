import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";

const LANGS = [
  { code: "en-IN", label: "EN" },
  { code: "ur-PK", label: "Urdu" },
];
const LANG_KEY = "rpl.voice.lang";

function recognitionCtor(): any {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** True when the browser can do speech-to-text here (needs HTTPS and a supporting browser). */
export function voiceSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && !!recognitionCtor();
}

/**
 * Mic button next to a text field. Spoken words are appended to the current text,
 * which stays fully editable by typing. Renders nothing where voice is not available.
 */
export default function VoiceButton({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  compact?: boolean;
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem(LANG_KEY) || LANGS[0].code;
    } catch {
      return LANGS[0].code;
    }
  });
  const recRef = useRef<any>(null);
  const baseRef = useRef("");
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => () => recRef.current?.abort?.(), []);

  if (!voiceSupported()) return null;

  const stop = () => recRef.current?.stop?.();

  const start = () => {
    const Ctor = recognitionCtor();
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = true;
    baseRef.current = valueRef.current.trim();
    rec.onresult = (ev: any) => {
      let text = "";
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      text = text.trim();
      onChange([baseRef.current, text].filter(Boolean).join(" "));
    };
    rec.onerror = (ev: any) => {
      setError(ev.error === "not-allowed" ? "Microphone permission denied" : ev.error === "no-speech" ? "Didn't hear anything" : "Voice input stopped");
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setError("");
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  };

  const pickLang = (code: string) => {
    setLang(code);
    try {
      localStorage.setItem(LANG_KEY, code);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={`v2-voice ${compact ? "compact" : ""}`}>
      <button
        type="button"
        className={`v2-voice-btn ${listening ? "on" : ""}`}
        onClick={listening ? stop : start}
        aria-label={listening ? "Stop voice input" : "Speak instead of typing"}
        title={listening ? "Stop" : "Speak instead of typing"}
      >
        {listening ? <Square size={14} /> : <Mic size={16} />}
        {!compact && <span>{listening ? "Listening… tap to stop" : "Speak"}</span>}
      </button>
      {!listening && !compact && (
        <div className="v2-voice-langs" role="radiogroup" aria-label="Voice language">
          {LANGS.map((l) => (
            <button key={l.code} type="button" role="radio" aria-checked={lang === l.code} className={lang === l.code ? "active" : ""} onClick={() => pickLang(l.code)}>
              {l.label}
            </button>
          ))}
        </div>
      )}
      {error && <small className="v2-voice-err">{error}</small>}
    </div>
  );
}
