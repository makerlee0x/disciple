import Link from "next/link";

export default function NotFound() {
  return (
    <div className="ds-lost">
      <div>
        <h1>404</h1>
        <h2>Lost beyond the firmament</h2>
        <p>This rocket drifted out of orbit — the page you&apos;re looking for doesn&apos;t exist.</p>
        <div className="actions">
          <Link href="/" className="ds-btn gold">Back to the Launchpad</Link>
          <Link href="/create" className="ds-btn">Launch a Rocket</Link>
        </div>
      </div>
    </div>
  );
}
