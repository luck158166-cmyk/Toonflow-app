# Windows 本地开发

在仓库根目录使用 `package.json` 指定的 Bun 版本。首次初始化使用 `bun scripts/windows/initialize.ts`，该命令安装锁文件中的依赖并创建数据及日志目录，不配置模型或发起付费请求。

运行 `bun scripts/windows/environment.ts` 查看 Bun、Git、SQLite、磁盘空间和 FFmpeg 状态；缺少 FFmpeg 时使用 Toonflow 内置下载流程。

执行 `bun scripts/windows/devRuntime.ts start` 启动开发服务，页面默认是 `http://127.0.0.1:5173`，服务默认端口是 3000。可以用 `TOONFLOW_WEB_PORT`、`TOONFLOW_SERVER_PORT` 和 `TOONFLOW_DATA_DIR` 分别设置端口和数据目录。默认数据目录为仓库下的 `data/`。日志写入数据目录的 `logs/`。

在同一个终端按 Ctrl+C，或在另一个使用相同 `TOONFLOW_DATA_DIR` 的终端运行 `bun scripts/windows/devRuntime.ts stop` 停止。`status` 查询此数据目录的开发服务状态。启动脚本会拒绝同一数据目录的第二个会话，不通过端口或进程名结束其他程序。

Windows 浏览器开发模式下，首页“选择工作目录”打开页内选择窗。可以浏览数据目录下的服务器工作区，也可以输入本机文件夹的完整路径；后者经过服务端本地请求与真实目录校验。桌面安装版仍使用系统文件夹选择器。

该开发脚本不是桌面安装包，也不提供备份恢复。更改已有用户数据前请自行保留备份；生产项目备份恢复功能尚待实现与验证。
