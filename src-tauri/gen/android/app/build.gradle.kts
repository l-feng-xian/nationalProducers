import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// 可选的 release 签名。在本文件旁放一个 keystore.properties（已在 .gitignore 内）：
//   storeFile=<.jks 的绝对路径>
//   storePassword=… / keyAlias=… / keyPassword=…
// 有它就签名，没有它 release 仍能构建，只是产出未签名包（debug 不受影响）。
// 写成"存在才启用"是刻意的：别人 clone 下来没有密钥也不该构建失败。
val keystoreProperties = Properties().apply {
    val propFile = file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
val hasKeystore = keystoreProperties.getProperty("storeFile") != null

android {
    compileSdk = 36
    namespace = "com.example.nationalproducers"
    defaultConfig {
        // 放行明文。本应用的 baseUrl 由用户自己填，局域网里的 Ollama / LM Studio
        // 就是 http://192.168.x.x:11434 这种明文端点，禁掉等于砍掉一个正经用法。
        //
        // 代价其实为零：release 下 webview 只从 Tauri 自有协议加载本地资源，不走明文；
        // 而 provider 请求是 plugin-http → Rust reqwest 的原生 socket 发出的，
        // 本来就不归 Android 的 Java 网络栈管，这个开关对它没有约束力。
        // （后一条我没有设备可验证，若真机上明文端点连不上，这里是第一个要看的地方。）
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "com.example.nationalproducers"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (hasKeystore) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (hasKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")