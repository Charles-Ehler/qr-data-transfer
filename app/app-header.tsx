const BASE = import.meta.env.BASE_URL ?? "/";

export function AppHeader({ active }: { active: "send" | "scan" }) {
  return (
    <header className="site-header">
      <a className="wordmark" href={BASE} aria-label="QRFerry home">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span>QRFerry</span>
      </a>
      <nav className="mode-switch" aria-label="Transfer mode">
        <a className={active === "send" ? "active" : ""} href={BASE}>
          Send
        </a>
        <a className={active === "scan" ? "active" : ""} href={`${BASE}scan`}>
          Scan
        </a>
      </nav>
      <span className="local-badge">
        <span aria-hidden="true" />
        Device to device
      </span>
    </header>
  );
}
