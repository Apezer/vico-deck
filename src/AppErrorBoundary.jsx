import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * 捕获 React 渲染阶段错误，避免根节点被清空后只剩黑色窗口。
 * 错误只显示在当前界面和开发者控制台，不写入用户电脑上的日志文件。
 */
export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error:null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("VicoDeck renderer error", error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return <main className="app-error-page" role="alert">
      <section className="app-error-card">
        <div className="app-error-icon"><AlertTriangle size={30}/></div>
        <span>VICODECK ERROR</span>
        <h1>页面显示出现问题</h1>
        <p>软件已经拦截这次异常，因此不会继续显示黑屏。重新加载通常可以恢复。</p>
        <code>{error?.message || "未知的界面错误"}</code>
        <button type="button" onClick={() => window.location.reload()}>
          <RefreshCw size={16}/>重新加载软件
        </button>
        <small>如果问题反复出现，请将上面的错误信息和软件版本发送给开发者。</small>
      </section>
    </main>;
  }
}
