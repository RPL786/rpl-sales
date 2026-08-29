import { useEffect, useRef, useState } from "react";
import { Bot, Mic, Send, Volume2, X } from "lucide-react";

type ChatMessage = {
  role: "bot" | "user";
  text: string;
};

type Props = {
  apiBaseUrl: string;
};

declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
  }
}

export default function RessiBot({ apiBaseUrl }: Props) {
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "bot",
      text: "Welcome to Ressichem. Main aapka AI database assistant hoon. Aap sales, visits, targets, clients, products ya team performance ke bare me pooch sakte hain.",
    },
  ]);

  const recognitionRef = useRef<any>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const speak = (text: string) => {
    try {
      if (!("speechSynthesis" in window)) return;

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 0.95;
      utterance.pitch = 1.05;
      utterance.volume = 1;

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.error("Speech failed:", err);
    }
  };

  useEffect(() => {
    const alreadyWelcomed = sessionStorage.getItem("ressi_bot_welcome_done");

    if (!alreadyWelcomed) {
      sessionStorage.setItem("ressi_bot_welcome_done", "yes");

      setTimeout(() => {
        speak("Welcome to Ressichem");
      }, 900);
    }
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, open]);

  const askBot = async (text?: string) => {
    const cleanQuestion = (text || question).trim();

    if (!cleanQuestion || thinking) return;

    setQuestion("");
    setThinking(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", text: cleanQuestion },
    ]);

    try {
      const res = await fetch(`${apiBaseUrl}/api/ressi-bot`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
        },
        body: JSON.stringify({
          question: cleanQuestion,
          team: "",
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.detail || "AI bot failed");
      }

      const answer =
        result.answer ||
        "Database se clear jawab nahi mila. Sawal thora specific kar dein.";

      setMessages((prev) => [
        ...prev,
        { role: "bot", text: answer },
      ]);

      speak(answer);
    } catch (err: any) {
      const errorText = err.message || "AI bot connect nahi hua.";

      setMessages((prev) => [
        ...prev,
        { role: "bot", text: errorText },
      ]);

      speak(errorText);
    } finally {
      setThinking(false);
    }
  };

  const startListening = () => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      const msg = "Voice input is browser me supported nahi hai. Chrome use karein.";
      setMessages((prev) => [...prev, { role: "bot", text: msg }]);
      speak(msg);
      return;
    }

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;

    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
      setListening(true);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognition.onerror = () => {
      setListening(false);
      const msg = "Voice sunne me problem hui. Dobara mic button dabayein.";
      setMessages((prev) => [...prev, { role: "bot", text: msg }]);
    };

    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript || "";

      if (transcript) {
        setQuestion(transcript);
        askBot(transcript);
      }
    };

    recognition.start();
  };

  return (
    <>
      {!open && (
        <button
          className="ressi-bot-launcher"
          type="button"
          onClick={() => {
            setOpen(true);
            speak("Welcome to Ressichem");
          }}
        >
          <span className="ressi-robot-mini">
            <Bot size={24} />
          </span>
          <span>
            <strong>RessiBot</strong>
            <small>Boss AI Agent</small>
          </span>
        </button>
      )}

      {open && (
        <div className="ressi-bot-panel">
          <div className="ressi-bot-header">
            <div className="ressi-bot-brand">
              <div className={`ressi-robot-head ${listening ? "listening" : ""}`}>
                <div className="robot-antenna" />
                <div className="robot-eyes">
                  <span />
                  <span />
                </div>
                <div className="robot-mouth" />
              </div>

              <div>
                <strong>RessiBot</strong>
                <p>Ressichem DB Voice Agent</p>
              </div>
            </div>

            <button
              className="ressi-bot-icon-btn"
              type="button"
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          </div>

          <div className="ressi-bot-messages">
            {messages.map((msg, index) => (
              <div key={index} className={`ressi-msg ${msg.role}`}>
                {msg.text}
              </div>
            ))}

            {thinking && (
              <div className="ressi-msg bot">
                Database check kar raha hoon...
              </div>
            )}

            <div ref={endRef} />
          </div>

          <div className="ressi-bot-actions">
            <button
              className={`ressi-bot-icon-btn ${listening ? "active" : ""}`}
              type="button"
              onClick={startListening}
              title="Voice question"
            >
              <Mic size={18} />
            </button>

            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") askBot();
              }}
              placeholder="Boss ka sawal likhein ya mic dabayein..."
            />

            <button
              className="ressi-bot-icon-btn send"
              type="button"
              onClick={() => askBot()}
              disabled={thinking}
              title="Send"
            >
              <Send size={18} />
            </button>

            <button
              className="ressi-bot-icon-btn"
              type="button"
              onClick={() => speak(messages[messages.length - 1]?.text || "Welcome to Ressichem")}
              title="Repeat voice"
            >
              <Volume2 size={18} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}