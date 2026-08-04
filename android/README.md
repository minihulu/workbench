# 我的工作台 · 安卓端（原生 WebView 壳）

手机 App = 一个原生安卓窗口（WebView），加载你已部署的后端地址（网页版同一套代码），
登录 / 待办 / 时间账本 / GitHub 探索全部复用，数据走你后端的云端同步。

本工程**不依赖 npm / Capacitor**，纯原生 Gradle + WebView，只需 Android Studio 即可出包。

---

## 一、在你电脑出包（一次性，约 5~10 分钟）

> 前置：装好 **Android Studio**（免费，含 SDK 管理器）。首次打开会引导下载 SDK Platform / Build-Tools，按提示点即可。

1. 用 Android Studio 打开本 `android/` 文件夹（File → Open）。
2. 等它同步 Gradle、下载好 SDK（状态栏会提示，跟着点下一步）。
3. 菜单 **Build → Build Bundle(s) / APK(s) → Build APK(s)**。
4. 完成后右下角弹窗 **locate**，打开 `android/app/build/outputs/apk/debug/app-debug.apk`。
5. 把这个 apk 传到安卓手机安装即可（手机需允许「未知来源」安装）。

> 想要上架 / 正式签名版：Build → Generate Signed Bundle / APK，按向导生成密钥库（keystore）即可。

---

## 二、填上你的后端地址（必须改）

打开 `app/src/main/java/com/example/workbench/MainActivity.java`，改这一行：

```java
private static final String BACKEND_URL = "https://YOUR_BACKEND_URL";
```

- 云服务器：填你用 Docker 包部署后的域名，例如 `https://wb.yourdomain.com`
  （后端部署见仓库根 `README.deploy.md`，开 8000 端口 + https 反代）。
- 本地自测：手机和电脑同一 WiFi，填 `http://电脑局域网IP:8000`
  （如 `http://192.168.1.20:8000`），本工程已允许 http 明文，可直接连。

改完重新 Build 一次即可。

---

## 三、后端怎么部署（云服务器）

仓库根目录已有 `docker-compose.yml` + `Dockerfile` + `wb.env.example`：

```bash
# 在云服务器上
cd 含 docker-compose.yml 的目录
cp wb.env.example wb.env      # 按需填 GH_TOKEN / ADMIN_TOKEN 等
docker compose up -d          # 起服务，监听 8000
# 再用 Nginx/Caddy 反代 8000 到你的域名并配置 https
```

详见根目录 `README.deploy.md`。

---

## 四、说明

- WebView 已启用 `localStorage`（DOM Storage），登录态与待办/时间账本的多端同步正常持久。
- 包名 `com.example.workbench`，可在 `app/build.gradle` 的 `applicationId` 改成你自己的。
- 当前 `minSdk 24`（安卓 7.0+），覆盖绝大多数在用机型。
- iOS 端同理需要 Mac + Xcode，本工程未包含。
