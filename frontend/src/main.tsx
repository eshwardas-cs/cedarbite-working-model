import React, { Component } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

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
      return <main className="boot-fallback"><section className="boot-fallback-card"><div className="boot-fallback-mark" aria-hidden="true">C</div><h1>CedarBite couldn’t load</h1><p>Reload the page to try again.</p><button type="button" onClick={() => window.location.reload()}>Reload</button></section></main>;
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>,
);
