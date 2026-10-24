import { useState } from "react";
import { BarChart3, Eye, EyeOff, Loader2, Lock, MapPinned, ShieldCheck, User } from "lucide-react";
import { APP_VERSION } from "./Sidebar";

type Props = {
  username: string;
  password: string;
  error: string;
  onChange: (field: "username" | "password", value: string) => void;
  onSubmit: () => Promise<void> | void;
};

export default function LoginPage({ username, password, error, onChange, onSubmit }: Props) {
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v2-login">
      <div className="dashboard-bg-orb dashboard-bg-orb-1" />
      <div className="dashboard-bg-orb dashboard-bg-orb-2" />
      <div className="v2-noise" aria-hidden="true" />

      <section className="v2-login-hero" aria-hidden="true">
        <div className="v2-login-rings">
          <span />
          <span />
          <span />
          <img src="/logo.png" alt="" className="v2-login-logo" />
        </div>
        <h2>
          Sales Command Center
          <span className="v2-version">v{APP_VERSION}</span>
        </h2>
        <p>City, branch, team aur salesperson performance — ek hi jagah.</p>
        <ul className="v2-login-features">
          <li style={{ animationDelay: "0.35s" }}>
            <BarChart3 size={16} /> Multi-year sales intelligence
          </li>
          <li style={{ animationDelay: "0.45s" }}>
            <MapPinned size={16} /> Karachi · Lahore · Hub — branch wise
          </li>
          <li style={{ animationDelay: "0.55s" }}>
            <ShieldCheck size={16} /> Role-based secure access
          </li>
        </ul>
      </section>

      <form className="v2-login-card" onSubmit={submit} noValidate>
        <div className="v2-login-brand">
          <div className="v2-brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>RPL Sales</strong>
            <small>Ressichem Pvt Ltd</small>
          </div>
        </div>

        <h1>Welcome back</h1>
        <p className="v2-login-sub">Apne account se login karein</p>

        <label className="v2-field">
          <span>Username</span>
          <div className="v2-input">
            <User size={16} />
            <input
              autoFocus
              autoComplete="username"
              placeholder="Username"
              value={username}
              onChange={(e) => onChange("username", e.target.value)}
            />
          </div>
        </label>

        <label className="v2-field">
          <span>Password</span>
          <div className="v2-input">
            <Lock size={16} />
            <input
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => onChange("password", e.target.value)}
            />
            <button
              type="button"
              className="v2-eye"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>

        {error && (
          <div className="v2-login-error" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="v2-login-btn" disabled={busy || !username || !password}>
          {busy ? <Loader2 size={18} className="v2-spin" /> : null}
          <span>{busy ? "Signing in…" : "Login"}</span>
        </button>

        <p className="v2-login-foot">
          © {new Date().getFullYear()} Ressichem Pvt Ltd · RPL Sales v{APP_VERSION}
        </p>
      </form>
    </div>
  );
}
