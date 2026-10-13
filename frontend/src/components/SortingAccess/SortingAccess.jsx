import { useCallback, useEffect, useState } from 'react';
import { sortingJson, invalidateSortingRequests } from '../../sorting-api';
import './SortingAccess.css';

export default function SortingAccess({ children }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [unavailable, setUnavailable] = useState('');
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState('Connecting to SmartEco…');

  const checkSession = useCallback(async () => {
    setChecking(true);
    setUnavailable('');
    try { setSession(await sortingJson('/auth/session')); }
    catch (error) { if (error.status !== 401) setUnavailable(error.message); }
    finally { setChecking(false); }
  }, []);

  useEffect(() => {
    checkSession();
    const expired = () => { invalidateSortingRequests(); setSession(null); setMessage('Please sign in to continue.'); };
    window.addEventListener('sorting-session-expired', expired);
    return () => window.removeEventListener('sorting-session-expired', expired);
  }, [checkSession]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    let syncing = false;
    const sync = async () => {
      if (syncing || !active) return;
      syncing = true;
      try {
        const result = await sortingJson('/sync', {});
        if (active) setSyncStatus(result.pending ? `${result.pending} results waiting to sync` : 'Results synced to SmartEco');
      } catch (error) {
        if (active) setSyncStatus(error.status === 401 ? 'Session expired' : 'Saved locally · sync will retry');
      } finally { syncing = false; }
    };
    sync();
    const timer = setInterval(sync, 15000);
    window.addEventListener('sorting-result-saved', sync);
    window.addEventListener('online', sync);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('sorting-result-saved', sync);
      window.removeEventListener('online', sync);
    };
  }, [session]);

  async function login(event) {
    event.preventDefault();
    invalidateSortingRequests();
    setBusy(true); setMessage('');
    try {
      const result = await sortingJson(mode === 'password' ? '/auth/login' : '/auth/token',
        mode === 'password' ? { email: email.trim(), password } : { token: token.trim() });
      setPassword(''); setToken(''); setSession(result);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function logout() {
    invalidateSortingRequests();
    setBusy(true); setMessage('');
    try { await sortingJson('/auth/logout', {}); setSession(null); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  if (checking) return <div className="sorting-access-page"><p role="status">Checking sorting access…</p></div>;
  if (unavailable) return <div className="sorting-access-page"><section className="sorting-access-card">
    <h1>Unable to connect</h1><p role="alert">{unavailable}</p><button onClick={checkSession}>Try again</button>
  </section></div>;
  if (session) return <>
    <header className="sorting-account-bar">
      <div><strong>{session.business.name}</strong><span>{session.kiosk.name || 'AI Sorting'} · {syncStatus}</span></div>
      <button type="button" onClick={logout} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>
      {message && <p role="alert">{message}</p>}
    </header>
    {children}
  </>;

  return <main className="sorting-access-page"><section className="sorting-access-card">
    <div className="sorting-access-brand">SmartEco</div>
    <h1>Business AI Sorting</h1><p>Sign in with the credentials supplied by your administrator.</p>
    <div className="sorting-access-tabs" role="group" aria-label="Sign-in method">
      <button type="button" aria-pressed={mode === 'password'} onClick={() => { setMode('password'); setMessage(''); }}>Email & password</button>
      <button type="button" aria-pressed={mode === 'token'} onClick={() => { setMode('token'); setMessage(''); }}>Access token</button>
    </div>
    <form onSubmit={login}>
      {mode === 'password' ? <>
        <label>Email address<input type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      </> : <label>Access token<input type="password" required autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} /></label>}
      {message && <p className="sorting-access-error" role="alert">{message}</p>}
      <button className="sorting-access-submit" disabled={busy}>{busy ? 'Signing in…' : 'Open sorting app'}</button>
    </form>
  </section></main>;
}
