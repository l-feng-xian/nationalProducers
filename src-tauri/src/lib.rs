/// Tauri 入口。
///
/// 这里**不捆绑任何后端进程**：所有出网请求由前端经 plugin-http 走 Rust 的 reqwest，
/// 只为绕开 webview 的 CORS。（隔壁 sillyTavernTauri 捆了一个 axum server，那是为了
/// 把 API key 藏在服务端；本项目 key 本来就存在本机 IndexedDB 里，没有这个诉求，
/// 不值得为此多背一个 axum + sqlx 依赖和一个要维护的进程。）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ⚠️ 本机代理（clash / Privoxy 等，靠 HTTP_PROXY/HTTPS_PROXY 环境变量生效）默认会把
    // 发往 127.0.0.1 / 局域网的请求也一并劫走 —— 实测表现为：在线 LLM 正常（代理会转发
    // 外网），但连**本地 ComfyUI(:8188)** 或局域网服务(Ollama 等)直接失败，前端报
    // 「无法连接」。plugin-http 底层的 reqwest 读 NO_PROXY 决定哪些主机绕过代理，浏览器
    // 走的是系统代理(此处已禁用)所以网页版无此问题，唯独打包后的原生客户端会踩。
    // 这里在任何请求发生前，把本地环回与私有网段并进 NO_PROXY，保证本地/局域网**直连**，
    // 外网请求仍照常走代理；已有的 NO_PROXY 条目一并保留。
    ensure_local_direct();

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

/// 把本地环回与私有网段并入 NO_PROXY，保证 reqwest 直连本地/局域网服务，不经系统代理。
fn ensure_local_direct() {
    const LOCALS: &str = "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
    let existing = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    let merged = if existing.trim().is_empty() {
        LOCALS.to_string()
    } else {
        format!("{LOCALS},{existing}")
    };
    // reqwest 同时认大小写两种写法，一并设置最稳妥。
    std::env::set_var("NO_PROXY", &merged);
    std::env::set_var("no_proxy", &merged);
}
