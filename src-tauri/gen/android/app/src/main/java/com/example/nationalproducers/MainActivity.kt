package com.example.nationalproducers

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 软键盘：edge-to-edge 之后 adjustResize 不再自动缩窗口，键盘直接盖在 WebView 上，
    // 系统随即退回 adjustPan —— 把整个窗口往上推去露出光标，顶栏被推出屏幕
    // （用户报的「一打开键盘页面整体上移」）。WebView 自己也不处理 IME inset。
    // 这里手动把键盘高度垫成内容区的底内边距：WebView 缩到键盘上沿，
    // 网页里 100dvh 跟着变矮，输入条自然贴住键盘、顶栏不动。
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      if (v.paddingBottom != ime) v.setPadding(0, 0, 0, ime)
      insets
    }
  }
}
