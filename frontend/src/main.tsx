import React, { Component } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

function BootLogo() {
  return <div className="boot-fallback-brand" role="img" aria-label="CedarBite logo"><svg className="boot-fallback-logo" viewBox="0 0 64 64" aria-hidden="true"><path d="M9 25C15 14 24 9 32 8v13C24 22 18 26 14 33z" fill="#ffc928"/><path d="M55 25C49 14 40 9 32 8v13c8 1 14 5 18 12z" fill="#102b4c"/><path d="M12 36h40v5H12z" fill="#102b4c"/><path d="M19 34a13 13 0 0 1 26 0z" fill="#102b4c"/><path d="M20 44v11h5V44m7 0v11h5V44m7 0v11h5V44" fill="#ffc928"/><circle cx="49" cy="49" r="9" fill="#fff" stroke="#102b4c" strokeWidth="3"/><path d="m45 49 3 3 5-6" fill="none" stroke="#ffc928" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg><span>Cedar<span>Bite</span></span></div>;
}

class AppErrorBoundary extends Component<React.PropsWithChildren, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error("CedarBite could not render the page.", error);
  }

  render() {
    if (this.state.hasError) {
      return <main className="boot-fallback"><section className="boot-fallback-card"><BootLogo/><h1>CedarBite couldn’t load</h1><p>Reload the page to try again.</p><button type="button" onClick={() => window.location.reload()}>Reload</button></section></main>;
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>,
);
