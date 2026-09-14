import os
import re
import py_compile

BASE = os.path.join(os.path.dirname(__file__), '..', 'node_modules', '@electron', 'node-gyp', 'gyp', 'pylib', 'gyp')

# (文件名, [(正则, 替换函数), ...]) —— 替换保留原缩进
PATCHES = {
    'input.py': [
        (
            re.compile(r'^(\s*)replacement = result\.stdout\.decode\("utf-8"\)\.rstrip\(\)$', re.M),
            lambda m: f'{m.group(1)}replacement = result.stdout\n'
            f'{m.group(1)}if isinstance(replacement, bytes):\n'
            f'{m.group(1)}    replacement = replacement.decode("utf-8")\n'
            f'{m.group(1)}replacement = replacement.rstrip()'
        ),
        (
            re.compile(r'^(\s*)replacement = replacement\.decode\("utf-8"\).*$', re.M),
            lambda m: f'{m.group(1)}if isinstance(replacement, bytes):\n'
            f'{m.group(1)}    replacement = replacement.decode("utf-8")'
        ),
        (
            re.compile(r'^(\s*)item = item\.decode\("utf-8"\).*$', re.M),
            lambda m: f'{m.group(1)}if isinstance(item, bytes):\n'
            f'{m.group(1)}    item = item.decode("utf-8")'
        ),
    ],
    'common.py': [
        (
            re.compile(r'^(\s*)lines = stdout\.decode\("utf-8"\)\.replace.*$', re.M),
            lambda m: f'{m.group(1)}if isinstance(stdout, bytes):\n'
            f'{m.group(1)}    stdout = stdout.decode("utf-8")\n'
            f'{m.group(1)}lines = stdout.replace("\\r\\n", "\\n").split("\\n")'
        ),
        (
            re.compile(r'^(\s*)stdout = out\.communicate\(\)\[0\]\.decode\("utf-8"\)$', re.M),
            lambda m: f'{m.group(1)}stdout = out.communicate()[0]\n'
            f'{m.group(1)}if isinstance(stdout, bytes):\n'
            f'{m.group(1)}    stdout = stdout.decode("utf-8")'
        ),
    ],
    'MSVSVersion.py': [
        (
            re.compile(r'^(\s*)text = p\.communicate\(\)\[0\]\.decode\("utf-8"\)$', re.M),
            lambda m: f'{m.group(1)}text = p.communicate()[0]\n'
            f'{m.group(1)}if isinstance(text, bytes):\n'
            f'{m.group(1)}    text = text.decode("utf-8")'
        ),
        (
            re.compile(r'^(\s*)path = p\.communicate\(\)\[0\]\.decode\("utf-8"\)\.strip\(\)$', re.M),
            lambda m: f'{m.group(1)}path = p.communicate()[0]\n'
            f'{m.group(1)}if isinstance(path, bytes):\n'
            f'{m.group(1)}    path = path.decode("utf-8")\n'
            f'{m.group(1)}path = path.strip()'
        ),
    ],
    'msvs_emulation.py': [
        (
            re.compile(r'^(\s*)stdout = p\.communicate\(\)\[0\]\.decode\("utf-8"\)$', re.M),
            lambda m: f'{m.group(1)}stdout = p.communicate()[0]\n'
            f'{m.group(1)}if isinstance(stdout, bytes):\n'
            f'{m.group(1)}    stdout = stdout.decode("utf-8")'
        ),
    ],
}

for fname, patches in PATCHES.items():
    path = os.path.join(BASE, fname)
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    total = 0
    for regex, repl in patches:
        text, n = regex.subn(repl, text)
        total += n
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    print(f'{fname}: 应用 {total} 处补丁')

print('--- 语法检查 ---')
for fname in PATCHES:
    py_compile.compile(os.path.join(BASE, fname), doraise=True)
    print(f'{fname} OK')
print('全部通过')
