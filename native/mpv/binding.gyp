{
  "targets": [
    {
      "target_name": "sakana_mpv",
      "sources": ["src/addon.cc"],
      "include_dirs": [],
      "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE"],
      "libraries": ["user32.lib", "gdi32.lib"],
      "cflags_cc": ["/std:c++17"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
