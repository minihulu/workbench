use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(desktop)]
use tauri::Manager;

/// 等待本机服务端口可连通（最多 timeout）
fn wait_for_port(addr: &str, timeout: Duration) {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(addr).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(300));
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 后端地址：默认本机 server.py；可用环境变量指向你部署的云端
            //   WORKBENCH_BACKEND=https://workbench.example.com  cargo tauri build
            let backend = std::env::var("WORKBENCH_BACKEND")
                .unwrap_or_else(|_| "http://127.0.0.1:8000".to_string());

            let is_local =
                backend.starts_with("http://127.0.0.1") || backend.starts_with("http://localhost");

            // 仅本机模式：自动拉起随包分发的 server.py
            if is_local {
                if let Ok(res_dir) = app.path().resource_dir() {
                    let server_py = res_dir.join("server.py");
                    if server_py.exists() {
                        // 数据库写到可写目录，避免安装目录（如 C:\Program Files）只读导致写失败
                        let data_dir = app
                            .path()
                            .app_data_dir()
                            .unwrap_or_else(|_| res_dir.clone());
                        let _ = std::fs::create_dir_all(&data_dir);

                        let python = std::env::var("WORKBENCH_PYTHON")
                            .unwrap_or_else(|_| "python".to_string());

                        match Command::new(&python)
                            .arg(&server_py)
                            .current_dir(&data_dir)
                            .env("PORT", "8000")
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                        {
                            Ok(_) => eprintln!("[workbench] server.py 已启动"),
                            Err(e) => eprintln!("[workbench] 启动 server.py 失败: {}", e),
                        }
                    } else {
                        eprintln!("[workbench] 未找到随包分发的 server.py: {:?}", server_py);
                    }
                }
                // 等服务就绪再让窗口跳转，避免白屏
                wait_for_port("127.0.0.1:8000", Duration::from_secs(15));
            }

            // 主窗口导航到后端地址
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(u) = url::Url::parse(&backend) {
                    let _ = win.navigate(tauri::WebviewUrl::External(u));
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
