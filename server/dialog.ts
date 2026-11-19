import { spawn } from 'node:child_process';

// Windows 原生对话框：通过 PowerShell 调用 Shell 的 IFileOpenDialog（与资源管理器同款的“选择文件夹”窗口），
// 以及 VisualBasic FileSystem 把文件移到回收站。参数全部通过环境变量传入，避免拼接命令行。

export class DialogUnsupportedError extends Error {
  code = 'unsupported';
}

const pickerSource = String.raw`
using System;
using System.Runtime.InteropServices;
public static class CppIdeFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialogCom { }

  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);

  public static string Pick(IntPtr owner, string title, string initial) {
    IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogCom();
    uint options;
    dialog.GetOptions(out options);
    // FOS_NOCHANGEDIR | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
    dialog.SetOptions(options | 0x8 | 0x20 | 0x40 | 0x800);
    if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);
    dialog.SetOkButtonLabel("\u6253\u5f00"); // "Open" in Chinese, escaped to stay ASCII-only
    if (!String.IsNullOrEmpty(initial)) {
      try {
        Guid iid = typeof(IShellItem).GUID;
        IShellItem folder;
        SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
        dialog.SetFolder(folder);
      } catch { }
    }
    if (dialog.Show(owner) != 0) return null;
    IShellItem result;
    dialog.GetResult(out result);
    IntPtr name;
    result.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
    try { return Marshal.PtrToStringUni(name); } finally { Marshal.FreeCoTaskMem(name); }
  }
}
`;

// 所有脚本统一：出错时把异常信息以 UTF-8 + Base64 写到标准输出，避免 GBK 控制台编码和 CLIXML 进度信息造成乱码。
function wrap(body: string) {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
${body}
} catch {
  'ERROR:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
  exit 1
}
`;
}

const pickerScript = wrap(`Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
${pickerSource}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
try {
  $picked = [CppIdeFolderPicker]::Pick($owner.Handle, $env:CPPIDE_DIALOG_TITLE, $env:CPPIDE_DIALOG_INITIAL)
} finally {
  $owner.Close()
}
if ($picked) { 'RESULT:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($picked)) } else { 'RESULT:' }`);

// SHFileOperation 带 FOF_ALLOWUNDO 移到回收站；FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI 保证后台进程不会弹出看不见的对话框。
const recycleSource = String.raw`
using System;
using System.Runtime.InteropServices;
public static class CppIdeRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Op64 {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 1)]
  private struct Op32 {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHFileOperationW")]
  private static extern int Call64(ref Op64 op);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHFileOperationW")]
  private static extern int Call32(ref Op32 op);
  public static int Recycle(string path) {
    const uint FO_DELETE = 3;
    const ushort flags = 0x0004 | 0x0010 | 0x0040 | 0x0400; // SILENT | NOCONFIRMATION | ALLOWUNDO | NOERRORUI
    string from = path + "\0"; // pFrom must be double-null terminated
    if (IntPtr.Size == 8) {
      Op64 op = new Op64(); op.wFunc = FO_DELETE; op.pFrom = from; op.fFlags = flags;
      int result = Call64(ref op); return result != 0 ? result : (op.fAnyOperationsAborted ? -1 : 0);
    } else {
      Op32 op = new Op32(); op.wFunc = FO_DELETE; op.pFrom = from; op.fFlags = flags;
      int result = Call32(ref op); return result != 0 ? result : (op.fAnyOperationsAborted ? -1 : 0);
    }
  }
}
`;

const recycleScript = wrap(`Add-Type -TypeDefinition @'
${recycleSource}
'@
$code = [CppIdeRecycle]::Recycle($env:CPPIDE_RECYCLE_TARGET)
if ($code -ne 0) { throw ('SHFileOperation error 0x{0:X}' -f $code) }
'RESULT:ok'`);

function powershell(script: string, env: Record<string, string>, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (error: Error | null, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish(new Error('操作超时，已取消'));
    }, timeoutMs);
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    child.on('error', error => finish(new Error('无法启动 PowerShell：' + error.message)));
    child.on('exit', code => {
      const failure = /ERROR:([A-Za-z0-9+/=]*)/.exec(out);
      if (failure) return finish(new Error(Buffer.from(failure[1], 'base64').toString('utf8').trim() || `PowerShell 退出码 ${code}`));
      const match = /RESULT:([A-Za-z0-9+/=]*)/.exec(out);
      if (code === 0 && match) return finish(null, match[1]);
      const detail = err.replace(/#< CLIXML[\s\S]*/, '').trim().split(/\r?\n/)[0];
      finish(new Error(detail || `PowerShell 退出码 ${code}`));
    });
  });
}

let pickerOpen = false;

/** 弹出 Windows 资源管理器样式的文件夹选择窗口；取消时返回 null。 */
export async function pickFolder(title: string, initial: string): Promise<string | null> {
  if (process.platform !== 'win32') throw new DialogUnsupportedError('当前系统无法调用资源管理器，请手动输入文件夹路径');
  if (pickerOpen) throw new Error('文件夹选择窗口已经打开，请先在弹出的窗口中完成选择');
  pickerOpen = true;
  try {
    const encoded = await powershell(pickerScript, { CPPIDE_DIALOG_TITLE: title, CPPIDE_DIALOG_INITIAL: initial }, 15 * 60 * 1000);
    return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null;
  } catch (error) {
    throw new Error('打开文件夹选择窗口失败：' + (error instanceof Error ? error.message : String(error)));
  } finally {
    pickerOpen = false;
  }
}

/** 删除文件：Windows 上移到回收站（不弹出任何系统对话框），其他系统直接删除。 */
export async function removeFile(target: string, unlink: (p: string) => Promise<void>) {
  if (process.platform !== 'win32') return unlink(target);
  try {
    await powershell(recycleScript, { CPPIDE_RECYCLE_TARGET: target }, 30 * 1000);
  } catch (error) {
    throw new Error('删除失败（文件可能正被其他程序占用）：' + (error instanceof Error ? error.message : String(error)));
  }
}

/** 在资源管理器中显示文件（选中它）或打开文件夹。 */
export function revealInExplorer(target: string, select: boolean) {
  if (process.platform !== 'win32') throw new DialogUnsupportedError('仅 Windows 支持在资源管理器中显示');
  const child = spawn('explorer.exe', select ? ['/select,', target] : [target], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
