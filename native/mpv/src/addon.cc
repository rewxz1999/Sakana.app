/*
 * sakana_mpv —— libmpv 播放内核的 N-API 绑定（Windows）
 *
 * 设计要点：
 * 1) 动态加载 libmpv-2.dll（LoadLibrary + GetProcAddress），编译期不依赖 mpv 库；
 * 2) 在 Electron 主窗口内创建一个 WS_CHILD 子窗口作为视频输出表面，并把该 HWND
 *    通过 mpv 的 wid 选项交给 libmpv —— 与 electron-vlc-player 的嵌入方式同构，
 *    因此渲染层可以用完全相同的布局（#vlc-host 区域）承载 mpv 画面；
 * 3) 只使用 N-API（ABI 稳定），因此用本机 Node 头文件构建即可在 Electron 中加载；
 * 4) 状态读取采用属性查询（time-pos / duration / pause / eof-reached），
 *    由 JS 侧定时轮询，避免跨线程回调带来的复杂度。
 */
#define NAPI_VERSION 8
#include <node_api.h>

#include <windows.h>
#include <string>
#include <vector>
#include <cstdint>
#include <cstring>

// ---------------- libmpv 动态绑定 ----------------

typedef struct mpv_handle mpv_handle;
typedef struct mpv_event mpv_event;

struct MpvApi {
  HMODULE dll = nullptr;
  mpv_handle* (*create)() = nullptr;
  int (*initialize)(mpv_handle*) = nullptr;
  void (*destroy)(mpv_handle*) = nullptr;
  void (*terminate_destroy)(mpv_handle*) = nullptr;
  int (*set_option_string)(mpv_handle*, const char*, const char*) = nullptr;
  int (*set_property_string)(mpv_handle*, const char*, const char*) = nullptr;
  char* (*get_property_string)(mpv_handle*, const char*) = nullptr;
  int (*set_property)(mpv_handle*, const char*, int, void*) = nullptr;
  int (*get_property)(mpv_handle*, const char*, int, void*) = nullptr;
  int (*command)(mpv_handle*, const char**) = nullptr;
  const char* (*error_string)(int) = nullptr;
  void (*free)(void*) = nullptr;
  mpv_event* (*wait_event)(mpv_handle*, double) = nullptr;
  void (*wakeup)(mpv_handle*) = nullptr;
};

enum MpvFormat {
  MPV_FORMAT_NONE = 0,
  MPV_FORMAT_STRING = 1,
  MPV_FORMAT_FLAG = 3,
  MPV_FORMAT_INT64 = 4,
  MPV_FORMAT_DOUBLE = 5
};

static MpvApi g_api;
static bool g_loaded = false;

static std::string g_lastError;

static void setError(const std::string& msg) { g_lastError = msg; }

static napi_value MakeBool(napi_env env, bool v) {
  napi_value out;
  napi_get_boolean(env, v, &out);
  return out;
}

static napi_value MakeString(napi_env env, const std::string& s) {
  napi_value out;
  napi_create_string_utf8(env, s.c_str(), NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value MakeDouble(napi_env env, double v) {
  napi_value out;
  napi_create_double(env, v, &out);
  return out;
}

static napi_value MakeInt(napi_env env, int64_t v) {
  napi_value out;
  napi_create_int64(env, v, &out);
  return out;
}

static napi_value MakeNull(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}

static std::string GetStringArg(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) return std::string();
  // 多留 1 字节给终止符，再按实际拷贝长度收缩（此前把 len+1 当缓冲区大小写入了 len 大小的 string）
  std::string s(len + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, v, s.data(), s.size(), &copied) != napi_ok) return std::string();
  s.resize(copied);
  return s;
}

/** UTF-8 → UTF-16：安装路径含中文时必须正确转换，否则 LoadLibraryW 找不到 DLL */
static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  const int need = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  if (need <= 0) return std::wstring();
  std::wstring w((size_t)need, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], need);
  return w;
}

static bool IsString(napi_env env, napi_value v) {
  napi_valuetype t;
  if (napi_typeof(env, v, &t) != napi_ok) return false;
  return t == napi_string;
}

// ---------------- 会话状态 ----------------

static HWND g_child = nullptr;      // 视频输出子窗口
static HWND g_parent = nullptr;     // Electron 主窗口
static HWND g_host = nullptr;       // 实际承载视频窗口的宿主（优先页面渲染窗口）
static int g_x = 0, g_y = 0, g_w = 0, g_h = 0;
static bool g_created = false;
/** 视频输出窗口是否可见（探针网页视图需要同区域显示时置 false） */
static bool g_visible = true;
static mpv_handle* g_mpv = nullptr;
static void RaiseChild();
static bool CreateChildWindow();
static HWND FindRenderWidget(HWND parent);
/** 由 create() 传入的自定义选项（在默认选项之后应用） */
static std::vector<std::pair<std::string, std::string>> g_optionOverrides;

static bool EnsureApi() {
  if (g_loaded) return true;
  setError("libmpv 尚未加载");
  return false;
}

// ---------------- 导出：load(dllPath) ----------------

static napi_value Load(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1 || !IsString(env, argv[0])) {
    setError("load(dllPath) 需要字符串参数");
    return MakeBool(env, false);
  }
  std::string path = GetStringArg(env, argv[0]);
  // 必须走 UTF-8 → UTF-16 转换：逐字节拓宽会把中文路径变成乱码，LoadLibraryW 直接失败
  std::wstring wpath = Utf8ToWide(path);

  if (g_api.dll) {
    FreeLibrary(g_api.dll);
    g_api = MpvApi();
    g_loaded = false;
  }

  HMODULE dll = LoadLibraryW(wpath.c_str());
  if (!dll) {
    setError("无法加载 " + path + "（错误码 " + std::to_string(GetLastError()) + "）");
    return MakeBool(env, false);
  }
  auto sym = [dll](const char* name) { return GetProcAddress(dll, name); };

  g_api.dll = dll;
  g_api.create = (decltype(g_api.create))sym("mpv_create");
  g_api.initialize = (decltype(g_api.initialize))sym("mpv_initialize");
  g_api.destroy = (decltype(g_api.destroy))sym("mpv_destroy");
  g_api.terminate_destroy = (decltype(g_api.terminate_destroy))sym("mpv_terminate_destroy");
  g_api.set_option_string = (decltype(g_api.set_option_string))sym("mpv_set_option_string");
  g_api.set_property_string = (decltype(g_api.set_property_string))sym("mpv_set_property_string");
  g_api.get_property_string = (decltype(g_api.get_property_string))sym("mpv_get_property_string");
  g_api.set_property = (decltype(g_api.set_property))sym("mpv_set_property");
  g_api.get_property = (decltype(g_api.get_property))sym("mpv_get_property");
  g_api.command = (decltype(g_api.command))sym("mpv_command");
  g_api.error_string = (decltype(g_api.error_string))sym("mpv_error_string");
  g_api.free = (decltype(g_api.free))sym("mpv_free");
  g_api.wait_event = (decltype(g_api.wait_event))sym("mpv_wait_event");
  g_api.wakeup = (decltype(g_api.wakeup))sym("mpv_wakeup");

  if (!g_api.create || !g_api.initialize || !g_api.command || !g_api.get_property) {
    setError("libmpv 导出符号不完整，可能不是有效的 libmpv-2.dll");
    FreeLibrary(dll);
    g_api = MpvApi();
    return MakeBool(env, false);
  }
  g_loaded = true;
  g_lastError.clear();
  return MakeBool(env, true);
}

// ---------------- 导出：create({ x, y, width, height, parentHwnd }) ----------------

static napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!EnsureApi()) return MakeBool(env, false);

  int64_t x = 0, y = 0, w = 1280, h = 720;
  int64_t parent = 0;
  bool hasParent = false;

  if (argc >= 1) {
    napi_value v;
    if (napi_get_named_property(env, argv[0], "options", &v) == napi_ok && v) {
      napi_valuetype ot;
      napi_typeof(env, v, &ot);
      if (ot == napi_object) {
        // 收集自定义选项（在默认选项之后应用，可覆盖）
        napi_value keys;
        if (napi_get_property_names(env, v, &keys) == napi_ok) {
          uint32_t n = 0;
          napi_get_array_length(env, keys, &n);
          for (uint32_t i = 0; i < n; i++) {
            napi_value k, val;
            napi_get_element(env, keys, i, &k);
            napi_get_property(env, v, k, &val);
            g_optionOverrides.push_back({GetStringArg(env, k), GetStringArg(env, val)});
          }
        }
      }
    }
    if (napi_get_named_property(env, argv[0], "x", &v) == napi_ok && v) {
      napi_get_value_int64(env, v, &x);
    }
    if (napi_get_named_property(env, argv[0], "y", &v) == napi_ok && v) {
      napi_get_value_int64(env, v, &y);
    }
    if (napi_get_named_property(env, argv[0], "width", &v) == napi_ok && v) {
      napi_get_value_int64(env, v, &w);
    }
    if (napi_get_named_property(env, argv[0], "height", &v) == napi_ok && v) {
      napi_get_value_int64(env, v, &h);
    }
    if (napi_get_named_property(env, argv[0], "parentHwnd", &v) == napi_ok && v) {
      // 支持传入 Buffer（Electron getNativeWindowHandle）或数字
      bool isBuffer = false;
      napi_is_buffer(env, v, &isBuffer);
      if (isBuffer) {
        void* data = nullptr;
        size_t len = 0;
        if (napi_get_buffer_info(env, v, &data, &len) == napi_ok && data && len >= sizeof(void*)) {
          parent = (int64_t)(*(intptr_t*)data);
          hasParent = parent != 0;
        }
      } else {
        napi_valuetype t;
        napi_typeof(env, v, &t);
        if (t == napi_number) {
          napi_get_value_int64(env, v, &parent);
          hasParent = parent != 0;
        }
      }
    }
  }

  g_x = (int)x;
  g_y = (int)y;
  g_w = (int)w;
  g_h = (int)h;

  if (hasParent && !g_child) {
    g_parent = (HWND)(intptr_t)parent;
    if (!CreateChildWindow()) {
      setError("创建视频输出子窗口失败（错误码 " + std::to_string(GetLastError()) + "）");
      return MakeBool(env, false);
    }
  }

  if (g_created) {
    // 复用已有 mpv 实例：仅更新尺寸
    if (g_child) SetWindowPos(g_child, nullptr, g_x, g_y, g_w, g_h, SWP_NOZORDER | SWP_NOACTIVATE);
    return MakeBool(env, true);
  }

  mpv_handle* mpv = g_api.create();
  if (!mpv) {
    setError("mpv_create 失败（libmpv 初始化异常）");
    return MakeBool(env, false);
  }

  // 关键选项：嵌入指定窗口、硬件解码、空闲保持、允许窗口缩放
  g_api.set_option_string(mpv, "vo", "gpu");
  g_api.set_option_string(mpv, "hwdec", "auto-safe");
  g_api.set_option_string(mpv, "keep-open", "yes");
  g_api.set_option_string(mpv, "idle", "yes");
  g_api.set_option_string(mpv, "force-window", "no");
  g_api.set_option_string(mpv, "input-default-bindings", "no");
  g_api.set_option_string(mpv, "osc", "no");
  g_api.set_option_string(mpv, "osd-level", "1");
  g_api.set_option_string(mpv, "ytdl", "no");
  g_api.set_option_string(mpv, "config", "no");
  g_api.set_option_string(mpv, "terminal", "no");
  if (g_child) {
    std::string wid = std::to_string((intptr_t)g_child);
    g_api.set_option_string(mpv, "wid", wid.c_str());
  }
  // 自定义/覆盖选项（例如自检时用 vo=null 做无窗口解码验证）
  for (auto& kv : g_optionOverrides) {
    g_api.set_option_string(mpv, kv.first.c_str(), kv.second.c_str());
  }
  g_optionOverrides.clear();

  int rc = g_api.initialize(mpv);
  if (rc < 0) {
    setError(std::string("mpv_initialize 失败: ") + (g_api.error_string ? g_api.error_string(rc) : std::to_string(rc)));
    g_api.terminate_destroy ? g_api.terminate_destroy(mpv) : g_api.destroy(mpv);
    return MakeBool(env, false);
  }
  g_mpv = mpv;
  g_created = true;
  g_lastError.clear();
  return MakeBool(env, true);
}

// ---------------- 导出：resize({x,y,width,height}) ----------------

static napi_value Resize(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc >= 1) {
    napi_value v;
    int64_t x = g_x, y = g_y, w = g_w, h = g_h;
    if (napi_get_named_property(env, argv[0], "x", &v) == napi_ok && v) napi_get_value_int64(env, v, &x);
    if (napi_get_named_property(env, argv[0], "y", &v) == napi_ok && v) napi_get_value_int64(env, v, &y);
    if (napi_get_named_property(env, argv[0], "width", &v) == napi_ok && v) napi_get_value_int64(env, v, &w);
    if (napi_get_named_property(env, argv[0], "height", &v) == napi_ok && v) napi_get_value_int64(env, v, &h);
    g_x = (int)x;
    g_y = (int)y;
    g_w = (int)w;
    g_h = (int)h;
  }
  if (g_child) {
    SetWindowPos(g_child, nullptr, g_x, g_y, g_w, g_h, SWP_NOZORDER | SWP_NOACTIVATE);
    // 尺寸变化后重新提升：Chromium 重绘/布局时会把自己提到上层
    if (g_visible) RaiseChild();
    return MakeBool(env, true);
  }
  return MakeBool(env, false);
}

// ---------------- 导出：command(args[]) ----------------

static napi_value Command(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!g_created || !g_mpv) {
    setError("播放器尚未创建");
    return MakeBool(env, false);
  }
  if (argc < 1) {
    setError("command(args) 需要字符串数组");
    return MakeBool(env, false);
  }
  uint32_t len = 0;
  if (napi_get_array_length(env, argv[0], &len) != napi_ok) {
    setError("command(args) 需要字符串数组");
    return MakeBool(env, false);
  }
  std::vector<std::string> store;
  store.reserve(len);
  for (uint32_t i = 0; i < len; i++) {
    napi_value item;
    napi_get_element(env, argv[0], i, &item);
    store.push_back(GetStringArg(env, item));
  }
  std::vector<const char*> args;
  args.reserve(store.size() + 1);
  for (auto& s : store) args.push_back(s.c_str());
  args.push_back(nullptr);

  int rc = g_api.command(g_mpv, args.data());
  if (rc < 0) {
    setError(std::string("mpv 命令失败: ") + (g_api.error_string ? g_api.error_string(rc) : std::to_string(rc)));
    return MakeBool(env, false);
  }
  return MakeBool(env, true);
}

// ---------------- 导出：setProperty(name, value) ----------------

static napi_value SetProperty(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!g_created || !g_mpv) {
    setError("播放器尚未创建");
    return MakeBool(env, false);
  }
  if (argc < 2) {
    setError("setProperty(name, value) 需要两个参数");
    return MakeBool(env, false);
  }
  std::string name = GetStringArg(env, argv[0]);
  napi_valuetype t;
  napi_typeof(env, argv[1], &t);
  int rc = -1;
  if (t == napi_string) {
    rc = g_api.set_property_string(g_mpv, name.c_str(), GetStringArg(env, argv[1]).c_str());
  } else if (t == napi_boolean) {
    bool b = false;
    napi_get_value_bool(env, argv[1], &b);
    int flag = b ? 1 : 0;
    rc = g_api.set_property(g_mpv, name.c_str(), MPV_FORMAT_FLAG, &flag);
  } else if (t == napi_number) {
    double d = 0;
    napi_get_value_double(env, argv[1], &d);
    rc = g_api.set_property(g_mpv, name.c_str(), MPV_FORMAT_DOUBLE, &d);
  } else {
    setError("不支持的属性类型");
    return MakeBool(env, false);
  }
  if (rc < 0) {
    setError(std::string("设置属性失败 ") + name + ": " +
             (g_api.error_string ? g_api.error_string(rc) : std::to_string(rc)));
    return MakeBool(env, false);
  }
  return MakeBool(env, true);
}

// ---------------- 导出：getProperty(name) ----------------

static napi_value GetProperty(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!g_created || !g_mpv || argc < 1) return MakeNull(env);
  std::string name = GetStringArg(env, argv[0]);

  double d = 0;
  if (g_api.get_property(g_mpv, name.c_str(), MPV_FORMAT_DOUBLE, &d) >= 0) return MakeDouble(env, d);
  int flag = 0;
  if (g_api.get_property(g_mpv, name.c_str(), MPV_FORMAT_FLAG, &flag) >= 0) return MakeBool(env, flag != 0);
  if (g_api.get_property_string) {
    char* s = g_api.get_property_string(g_mpv, name.c_str());
    if (s) {
      napi_value out = MakeString(env, s);
      g_api.free(s);
      return out;
    }
  }
  return MakeNull(env);
}

// ---------------- 导出：state() ----------------

static double GetDoubleProp(const char* name, bool* ok = nullptr) {
  double v = 0;
  int rc = g_api.get_property(g_mpv, name, MPV_FORMAT_DOUBLE, &v);
  if (ok) *ok = rc >= 0;
  return rc >= 0 ? v : 0;
}

static bool GetFlagProp(const char* name) {
  int v = 0;
  return g_api.get_property(g_mpv, name, MPV_FORMAT_FLAG, &v) >= 0 && v != 0;
}

static napi_value State(napi_env env, napi_callback_info info) {
  napi_value obj;
  napi_create_object(env, &obj);
  if (!g_created || !g_mpv) {
    napi_set_named_property(env, obj, "ready", MakeBool(env, false));
    return obj;
  }
  bool hasTime = false, hasDur = false;
  double pos = GetDoubleProp("time-pos", &hasTime);
  double dur = GetDoubleProp("duration", &hasDur);
  double vol = GetDoubleProp("volume");
  napi_set_named_property(env, obj, "ready", MakeBool(env, true));
  napi_set_named_property(env, obj, "time", MakeDouble(env, hasTime ? pos * 1000.0 : 0));
  napi_set_named_property(env, obj, "length", MakeDouble(env, hasDur ? dur * 1000.0 : 0));
  napi_set_named_property(env, obj, "paused", MakeBool(env, GetFlagProp("pause")));
  napi_set_named_property(env, obj, "idle", MakeBool(env, GetFlagProp("idle-active")));
  napi_set_named_property(env, obj, "eof", MakeBool(env, GetFlagProp("eof-reached")));
  napi_set_named_property(env, obj, "volume", MakeDouble(env, vol));
  napi_set_named_property(env, obj, "mute", MakeBool(env, GetFlagProp("mute")));
  return obj;
}

// ---------------- 导出：windows() 诊断窗口树 ----------------

static BOOL CALLBACK EnumChildProc(HWND h, LPARAM lp) {
  auto* out = reinterpret_cast<std::vector<std::string>*>(lp);
  wchar_t cls[256] = {0};
  GetClassNameW(h, cls, 255);
  RECT r{};
  GetWindowRect(h, &r);
  HWND parent = GetParent(h);
  POINT tl{r.left, r.top};
  if (parent) ScreenToClient(parent, &tl);
  long long style = (long long)GetWindowLongPtrW(h, GWL_STYLE);
  long long exstyle = (long long)GetWindowLongPtrW(h, GWL_EXSTYLE);
  char buf[640];
  snprintf(buf, sizeof(buf),
           "{\"hwnd\":%lld,\"class\":\"%ls\",\"visible\":%d,\"rect\":[%ld,%ld,%ld,%ld],\"style\":0x%llx,\"ex\":0x%llx}",
           (long long)(intptr_t)h, cls, IsWindowVisible(h) ? 1 : 0, (long)tl.x, (long)tl.y,
           (long)(r.right - r.left), (long)(r.bottom - r.top), style, exstyle);
  out->push_back(buf);
  return TRUE;
}

/** 诊断：返回自建子窗口与父窗口下的窗口树（用于排查「有声音无画面」） */
static napi_value Windows(napi_env env, napi_callback_info info) {
  napi_value obj;
  napi_create_object(env, &obj);
  auto dump = [&](HWND h, const char* name) {
    napi_value arr;
    napi_create_array(env, &arr);
    if (h) {
      std::vector<std::string> kids;
      EnumChildWindows(h, EnumChildProc, (LPARAM)&kids);
      uint32_t i = 0;
      for (auto& s : kids) {
        napi_value v;
        napi_create_string_utf8(env, s.c_str(), NAPI_AUTO_LENGTH, &v);
        napi_set_element(env, arr, i++, v);
      }
    }
    napi_set_named_property(env, obj, name, arr);
  };
  dump(g_parent, "parentChildren");
  dump(g_child, "childChildren");
  return obj;
}

/** 诊断：返回任意窗口的窗口树（传入 Electron getNativeWindowHandle 的 Buffer 或数字） */
static napi_value WindowsOf(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HWND h = nullptr;
  if (argc >= 1 && argv[0]) {
    bool isBuffer = false;
    napi_is_buffer(env, argv[0], &isBuffer);
    if (isBuffer) {
      void* data = nullptr;
      size_t len = 0;
      if (napi_get_buffer_info(env, argv[0], &data, &len) == napi_ok && data && len >= sizeof(void*)) {
        h = (HWND)(*(intptr_t*)data);
      }
    } else {
      napi_valuetype t;
      napi_typeof(env, argv[0], &t);
      if (t == napi_number) {
        int64_t v = 0;
        napi_get_value_int64(env, argv[0], &v);
        h = (HWND)(intptr_t)v;
      }
    }
  }
  napi_value arr;
  napi_create_array(env, &arr);
  if (h) {
    std::vector<std::string> kids;
    EnumChildWindows(h, EnumChildProc, (LPARAM)&kids);
    uint32_t i = 0;
    for (auto& s : kids) {
      napi_value v;
      napi_create_string_utf8(env, s.c_str(), NAPI_AUTO_LENGTH, &v);
      napi_set_element(env, arr, i++, v);
    }
  }
  return arr;
}

// ---------------- 窗口提升（z 序） ----------------

/**
 * 把视频输出窗口提到 z 序顶端。
 * Chromium 的页面内容（Chrome_RenderWidgetHostHWND / DComp 合成层）会盖住普通
 * 原生子窗口，必须像 electron-vlc-player 的 RaiseAboveWebContent 那样显式提升，
 * 否则表现为「有声音、一片黑屏」。
 */
static void RaiseChild() {
  if (!g_child || !IsWindow(g_child)) return;
  SetWindowPos(g_child, HWND_TOP, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  UpdateWindow(g_child);
  InvalidateRect(g_child, nullptr, TRUE);
}

/**
 * 自愈：Chromium 重建渲染窗口时会连带销毁挂在它内部的视频窗口。
 * 定期检查（JS 侧 400ms 调用）发现窗口不存在就按当前宿主重新创建。
 */
static void EnsureAttached() {
  if (!g_parent) return;
  if (g_child && IsWindow(g_child)) {
    // 仅备选方案下需要维护「挂进页面渲染窗口」的宿主关系
    if (getenv("SAKANA_MPV_PARENT_WIDGET")) {
      HWND widget = FindRenderWidget(g_parent);
      if (widget && g_host != widget) {
        SetParent(g_child, widget);
        g_host = widget;
        SetWindowPos(g_child, HWND_TOP, g_x, g_y, g_w, g_h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
      }
    }
    if (g_visible) RaiseChild();
    return;
  }
  g_child = nullptr;
  g_host = nullptr;
  if (CreateChildWindow() && g_visible) RaiseChild();
}

// ---------------- 导出：raise() / setVisible(bool) ----------------

/** 显式提升 z 序（页面重绘后由 JS 侧调用） */
static napi_value Raise(napi_env env, napi_callback_info info) {
  RaiseChild();
  return MakeBool(env, g_child != nullptr && IsWindow(g_child));
}

/** 自愈检查：窗口丢失/宿主变化时重建或重挂 */
static napi_value Ensure(napi_env env, napi_callback_info info) {
  EnsureAttached();
  return MakeBool(env, g_child != nullptr && IsWindow(g_child));
}

/**
 * 显示/隐藏视频输出窗口。
 * 探针网页视图（WebContentsView）需要在同一区域显示播放页时，必须先把
 * 视频窗口隐藏，否则被提升到顶端的视频窗会盖住探针页面。
 */
static napi_value SetVisible(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool visible = true;
  if (argc >= 1 && argv[0]) {
    napi_get_value_bool(env, argv[0], &visible);
  }
  g_visible = visible;
  if (g_child) {
    ShowWindow(g_child, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
    if (visible) RaiseChild();
  }
  return MakeBool(env, true);
}

// ---------------- 导出：hitTest(x,y) 判断谁在最上层 ----------------

/** 诊断：返回屏幕坐标点处最上层窗口的类名/HWND，以及是否属于本插件的视频窗口 */
static napi_value HitTest(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int64_t x = 0, y = 0;
  if (argc >= 2) {
    napi_get_value_int64(env, argv[0], &x);
    napi_get_value_int64(env, argv[1], &y);
  }
  POINT pt = {(LONG)x, (LONG)y};
  HWND hit = WindowFromPoint(pt);
  HWND root = GetAncestor(hit, GA_ROOT);
  HWND childRoot = g_child ? GetAncestor(g_child, GA_ROOT) : nullptr;
  wchar_t cls[256] = {0};
  if (hit) GetClassNameW(hit, cls, 255);

  napi_value obj;
  napi_create_object(env, &obj);
  napi_value v;
  napi_create_string_utf8(env, std::string(cls, cls + wcslen(cls)).c_str(), NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, "hitClass", v);
  napi_set_named_property(env, obj, "hitHwnd", MakeDouble(env, (double)(intptr_t)hit));
  napi_set_named_property(env, obj, "isOurChild", MakeBool(env, hit == g_child || (hit && IsChild(g_child, hit))));
  napi_set_named_property(env, obj, "hitRootIsOurs", MakeBool(env, root && childRoot && root == childRoot));
  napi_set_named_property(env, obj, "ourChildHwnd", MakeDouble(env, (double)(intptr_t)g_child));
  // 两条祖先链（自下而上直到桌面），用于定位窗口树分叉点
  auto chain = [&](HWND start) {
    napi_value arr;
    napi_create_array(env, &arr);
    uint32_t i = 0;
    HWND cur = start;
    while (cur && i < 16) {
      wchar_t c[256] = {0};
      GetClassNameW(cur, c, 255);
      char buf[320];
      snprintf(buf, sizeof(buf), "%ls(%lld)", c, (long long)(intptr_t)cur);
      napi_value s;
      napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &s);
      napi_set_element(env, arr, i++, s);
      HWND next = GetParent(cur);
      if (!next) next = GetWindow(cur, GW_OWNER);
      if (next == cur) break;
      cur = next;
    }
    return arr;
  };
  napi_set_named_property(env, obj, "ourChain", chain(g_child));
  napi_set_named_property(env, obj, "hitChain", chain(hit));
  napi_set_named_property(env, obj, "parentChain", chain(g_parent));
  return obj;
}

// ---------------- 导出：reparentToRenderWidget() ----------------

static BOOL CALLBACK FindWidgetProc(HWND h, LPARAM lp) {
  wchar_t cls[128] = {0};
  GetClassNameW(h, cls, 127);
  if (wcscmp(cls, L"Chrome_RenderWidgetHostHWND") == 0) {
    *reinterpret_cast<HWND*>(lp) = h;
    return FALSE;
  }
  return TRUE;
}

/** 找到页面渲染窗口（视频窗口要挂在它内部才能显示在页面之上） */
static HWND FindRenderWidget(HWND parent) {
  HWND widget = nullptr;
  if (parent) EnumChildWindows(parent, FindWidgetProc, reinterpret_cast<LPARAM>(&widget));
  return widget;
}

/**
 * 创建视频输出子窗口。
 * 关键：优先挂到页面渲染窗口（Chrome_RenderWidgetHostHWND）内部。
 * 该窗口带 WS_CLIPCHILDREN，子窗口绘制在其内容之上；
 * 若只作为同级子窗口，无论怎么提升 z 序都会被页面内容盖住
 * （表现为有声音、黑屏）。找不到渲染窗口时退回主窗口，至少不崩。
 */
static bool CreateChildWindow() {
  if (!g_parent) return false;
  /*
   * 默认：视频窗口作为主窗口的同级子窗口（与 electron-vlc-player 一致），
   * 并靠 RaiseChild() 提升 z 序显示在页面之上 —— 实测这是决定性的：
   * 不做提升时画面完全不可见（有声音、黑屏），与 electron-vlc-player 的
   * RaiseAboveWebContent 同理。
   * SAKANA_MPV_PARENT_WIDGET=1 可改用「挂进页面渲染窗口内部」的备选方案（诊断用）。
   */
  HWND host = getenv("SAKANA_MPV_PARENT_WIDGET") ? FindRenderWidget(g_parent) : nullptr;
  HWND realParent = host ? host : g_parent;
  g_host = host;
  HINSTANCE inst = GetModuleHandleW(nullptr);
  g_child = CreateWindowExW(
      WS_EX_NOPARENTNOTIFY, L"STATIC", L"",
      WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS, g_x, g_y, g_w, g_h, realParent,
      nullptr, inst, nullptr);
  if (!g_child) return false;
  RaiseChild();
  return true;
}

/** 诊断：把视频窗口重挂到 Chromium 的渲染窗口内部 */
static napi_value ReparentToRenderWidget(napi_env env, napi_callback_info info) {
  if (!g_child || !g_parent) {
    setError("尚未创建子窗口");
    return MakeBool(env, false);
  }
  HWND widget = nullptr;
  EnumChildWindows(g_parent, FindWidgetProc, reinterpret_cast<LPARAM>(&widget));
  if (!widget) {
    setError("未找到 Chrome_RenderWidgetHostHWND");
    return MakeBool(env, false);
  }
  SetParent(g_child, widget);
  SetWindowPos(g_child, HWND_TOP, g_x, g_y, g_w, g_h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  RaiseChild();
  return MakeBool(env, true);
}

// ---------------- 导出：destroy() ----------------

static napi_value Destroy(napi_env env, napi_callback_info info) {
  if (g_mpv) {
    mpv_handle* mpv = g_mpv;
    g_mpv = nullptr;
    g_created = false;
    if (g_api.terminate_destroy) g_api.terminate_destroy(mpv);
    else if (g_api.destroy) g_api.destroy(mpv);
  }
  if (g_child) {
    DestroyWindow(g_child);
    g_child = nullptr;
    g_parent = nullptr;
  }
  return MakeBool(env, true);
}

// ---------------- 导出：lastError() ----------------

static napi_value LastError(napi_env env, napi_callback_info info) {
  return MakeString(env, g_lastError);
}

// ---------------- 模块注册 ----------------

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
      {"load", nullptr, Load, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resize", nullptr, Resize, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"command", nullptr, Command, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setProperty", nullptr, SetProperty, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getProperty", nullptr, GetProperty, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"state", nullptr, State, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"windows", nullptr, Windows, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"windowsOf", nullptr, WindowsOf, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"raise", nullptr, Raise, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"ensureAttached", nullptr, Ensure, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hitTest", nullptr, HitTest, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"reparentToRenderWidget", nullptr, ReparentToRenderWidget, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setVisible", nullptr, SetVisible, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"destroy", nullptr, Destroy, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"lastError", nullptr, LastError, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
