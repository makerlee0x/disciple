import Link from "next/link";

export default function NotFound() {
  return (
    <div className="ds-lost">
      <div>
        <h1>404</h1>
        <h2>This page is not here.</h2>
        <p>There is no rocket or page at this link.</p>
        <div className="actions">
          <Link href="/" className="ds-btn gold">Back to the Launchpad</Link>
          <Link href="/create" className="ds-btn">Launch a Rocket</Link>
        </div>
      </div>
    </div>
  );
}
