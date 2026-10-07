# release 包的混淆规则。
#
# Media3 的 AAR 自带 consumer proguard 规则（会随依赖自动应用），已经覆盖了它内部的
# 反射入口，所以这里只需要补本工程特有的东西。

# DefaultMediaSourceFactory（用在非 .m3u8 的直链上）是用反射去找 HlsMediaSource$Factory
# 之类的工厂类的。我们的代码里显式引用了 HlsMediaSource，所以它本来就不会被裁掉；
# 这里再保一次，是因为"被裁掉"的表现是**播放器悄悄退化成只认 mp4**，
# 没有任何报错，排查起来非常费劲，保一下成本极低。
-keep class androidx.media3.exoplayer.hls.HlsMediaSource { *; }
-keep class androidx.media3.exoplayer.hls.HlsMediaSource$Factory { *; }

# 本工程自己的类不需要额外 keep：
#  · JSON 是手写的，字段名是字符串字面量，混淆不会改字符串，所以协议字段名天然安全；
#    （这也是不引 Gson/kotlinx-serialization 的一个附带好处）
#  · 没有任何类通过反射实例化。

# 关掉 Media3 可选依赖缺失时的警告（我们没引 DASH / RTSP / Cast 等模块）。
-dontwarn androidx.media3.**
