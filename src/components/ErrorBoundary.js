// 탭 단위 React 에러 경계 — 자식 컴포넌트 throw 시 AdminApp 전체 unmount 방지 + 에러 메시지 가시화.
// 흰 화면 진단·복구용. componentDidCatch 콘솔 + 노란 박스 표시.
import React from "react";

export class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, info: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info);
    this.setState({ info });
  }
  reset = () => this.setState({ error: null, info: null });
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, margin: 20, background: '#FCE5E5', border: '1px solid #F6C9C9', borderRadius: 10, color: '#A81818', fontFamily: 'var(--font-base)' }}>
          <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>⚠ 화면 오류 발생</div>
          <div style={{ fontSize: 13, marginBottom: 10 }}>{this.props.label || '이 탭'}을 표시할 수 없습니다.</div>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,0.5)', padding: 10, borderRadius: 6, marginBottom: 8 }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          {this.state.error?.stack && (
            <details style={{ fontSize: 11, opacity: 0.8 }}>
              <summary style={{ cursor: 'pointer', marginBottom: 4 }}>스택 트레이스</summary>
              <pre style={{ whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,0.5)', padding: 8, borderRadius: 6 }}>{this.state.error.stack}</pre>
            </details>
          )}
          <button onClick={this.reset} style={{ marginTop: 10, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700 }}>
            다시 시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
