/// Tauri 入口。
///
/// 这里**不捆绑任何后端进程**：所有出网请求由前端经 plugin-http 走 Rust 的 reqwest，
/// 只为绕开 webview 的 CORS。（隔壁 sillyTavernTauri 捆了一个 axum server，那是为了
/// 把 API key 藏在服务端；本项目 key 本来就存在本机 IndexedDB 里，没有这个诉求，
/// 不值得为此多背一个 axum + sqlx 依赖和一个要维护的进程。）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // 扫码插件只有移动端实现
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
