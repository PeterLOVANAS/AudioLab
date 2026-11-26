"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { z } from "zod";
import type { Session } from "@/lib/contracts/session";
const sessionSchema = z.object({
  user: z
    .object({
      userId: z.string(),
      displayName: z.string(),
      mode: z.enum(["demo", "access"]),
    })
    .nullable()
    .default(null),
  memberships: z
    .array(
      z.object({
        projectId: z.string(),
        projectName: z.string(),
        displayName: z.string(),
        role: z.enum(["admin", "labeller"]),
      }),
    )
    .default([]),
  mode: z.enum(["demo", "access"]).optional(),
  loginUrl: z.string().nullable().optional(),
  error: z.string().optional(),
});
/** Authenticated identity owns the application tree; logging out/remapping a user
 * destroys the previous worker's local React answers instead of sharing state.
 */
export default function AuthGate({
  children,
}: {
  children: (session: Session, logout: () => Promise<void>, refresh:()=>Promise<void>) => ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [mode, setMode] = useState("access"),
    [loginUrl, setLoginUrl] = useState<string | null>(null);
  const epoch = useRef(0);
  async function refresh() {
    const request = ++epoch.current;
    try {
      const response = await fetch("/api/v1/auth/session", {
        cache: "no-store",
      });
      const data = sessionSchema.parse(await response.json());
      if (request !== epoch.current) return;
      if (!response.ok) throw new Error(data.error ?? "Login unavailable");
      setSession(
        data.user ? { user: data.user, memberships: data.memberships } : null,
      );
      setMode(data.mode ?? data.user?.mode ?? "access");
      setLoginUrl(data.loginUrl ?? null);
      if (!data.user && data.error && !data.error.startsWith("Login required"))
        setError(data.error);
    } catch (reason) {
      if (request !== epoch.current) return;
      setSession(null);
      setError(String(reason));
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, []);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
        }),
      });
      const body = z
        .object({ error: z.string().optional() })
        .parse(await response.json());
      if (!response.ok) throw new Error(body.error ?? "Login failed");
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    ++epoch.current;
    setBusy(true);
    try {
      const response = await fetch("/api/v1/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not revoke session");
      if (session?.user.mode === "access") {
        window.location.assign("/cdn-cgi/access/logout");
        return;
      }
      ++epoch.current;
      setSession(null);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <main className="auth-screen">
        <p>Checking login…</p>
      </main>
    );
  if (session)
    return <div key={session.user.userId}>{children(session, logout, refresh)}</div>;
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <h1>AudioLab</h1>
        <h2>Sign in</h2>
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        {mode === "demo" ? (
          <form onSubmit={login}>
            <p>
              Local demonstration accounts. Shared demo passwords are disabled
              in production.
            </p>
            <label>
              Username
              <input
                name="username"
                autoComplete="username"
                required
                maxLength={128}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
        ) : (
          <>
            <p>
              Use your organization’s identity provider. Access identities must
              be explicitly provisioned for AudioLab.
            </p>
            {loginUrl ? (
              <a href={loginUrl}>Continue with secure login</a>
            ) : (
              <p>
                Access configuration/account provisioning is required before
                deployment. Demo login is available only in explicitly
                configured loopback development.
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
