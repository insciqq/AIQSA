"use client";

import { Component, type ReactNode } from "react";

type Props = Readonly<{
  children: ReactNode;
  fallback: ReactNode;
  resetKey: string;
  onError?(): void;
}>;

/** A failed preview never takes its source editor or surrounding page with it. */
export class MarkdownPreviewBoundary extends Component<Props, { failed: boolean; resetKey: string }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: { resetKey: string }) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch() { this.props.onError?.(); }

  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
