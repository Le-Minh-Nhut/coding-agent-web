/**
 * Narrow render-error boundary for tool renderers.
 *
 * A malformed `args`/`details` payload can make a renderer throw; without a
 * boundary React unmounts the whole guest root and the phone shows a blank
 * page. This catches only the card's subtree — connection state, transcript
 * rows and the composer live outside it, so connection failures still surface
 * normally.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ToolErrorBoundaryProps {
  /** Label for the degraded line (usually the tool name). */
  name: string;
  children: ReactNode;
}

interface ToolErrorBoundaryState {
  failed: boolean;
}

export class ToolErrorBoundary extends Component<
  ToolErrorBoundaryProps,
  ToolErrorBoundaryState
> {
  override state: ToolErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ToolErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`tool render failed (${this.props.name}):`, error, info);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="tv-note tv-note--err">
          [render failed for {this.props.name}]
        </div>
      );
    }
    return this.props.children;
  }
}
