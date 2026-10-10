// Native "choose folder" dialog, shown on the machine that runs the gateway (the user's own PC).
//   Windows: PowerShell + IFileOpenDialog in folder mode (the Explorer-style dialog with a "새 폴더" button)
//   macOS:   osascript `choose folder`
//   Linux:   zenity or kdialog when installed
// Resolves { path } or { cancelled: true }; rejects with err.code "UNSUPPORTED" when no dialog is available.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Vista-style common dialog (address bar, navigation pane, "새 폴더" button) in folder-pick mode: IFileOpenDialog + FOS_PICKFOLDERS.
// The dialog is owned by an invisible top-most form and that form is forced to the foreground, otherwise it opens behind the browser.
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$compiled = $true
try { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PiFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  public class FileOpenDialogCoClass { }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
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
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);

  // Windows only lets the foreground thread hand out focus: attach to its input queue for a moment.
  public static void Foreground(IntPtr hwnd) {
    uint pid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint cur = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != cur && AttachThreadInput(cur, fgThread, true);
    try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); }
    finally { if (attached) AttachThreadInput(cur, fgThread, false); }
  }

  // Returns the chosen folder, or null when the user cancelled.
  public static string Pick(IntPtr owner, string start, string title) {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogCoClass();
    uint opts;
    dlg.GetOptions(out opts);
    dlg.SetOptions(opts | 0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
    if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
    if (!string.IsNullOrEmpty(start)) {
      try {
        Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
        IShellItem folder;
        SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
        dlg.SetFolder(folder);
      } catch { }
    }
    int hr = dlg.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return null; // ERROR_CANCELLED
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    IShellItem item;
    dlg.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@ } catch { $compiled = $false }
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.FormBorderStyle = 'None'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0
$owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point(0, 0)
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()
try {
  [PiFolderPicker]::Foreground($owner.Handle)
  $picked = [PiFolderPicker]::Pick($owner.Handle, $env:PI_PICK_START, $env:PI_PICK_TITLE)
} catch {
  # COM dialog unavailable: fall back to the classic folder tree dialog
  $fb = New-Object System.Windows.Forms.FolderBrowserDialog
  $fb.Description = $env:PI_PICK_TITLE
  $fb.ShowNewFolderButton = $true
  if ($env:PI_PICK_START -and (Test-Path -LiteralPath $env:PI_PICK_START)) { $fb.SelectedPath = $env:PI_PICK_START }
  if ($fb.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $fb.SelectedPath }
} finally {
  $owner.Close()
}
if ($picked) { [Console]::Out.Write($picked) }
`;

function which(cmd) {
	const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
	return r.status === 0;
}

function unsupported(msg) {
	const err = new Error(msg);
	err.code = "UNSUPPORTED";
	return err;
}

function buildCommand(start, title) {
	const env = { ...process.env, PI_PICK_START: start || "", PI_PICK_TITLE: title };
	if (process.platform === "win32") {
		const sysRoot = process.env.SystemRoot || "C:\\Windows";
		const ps = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const exe = existsSync(ps) ? ps : "powershell.exe";
		const encoded = Buffer.from(WIN_SCRIPT, "utf16le").toString("base64");
		return { exe, args: ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], env };
	}
	if (process.platform === "darwin") {
		const script = `try\nPOSIX path of (choose folder with prompt (system attribute "PI_PICK_TITLE")${start ? ` default location (POSIX file (system attribute "PI_PICK_START"))` : ""})\non error number -128\nreturn ""\nend try`;
		return { exe: "osascript", args: ["-e", script], env };
	}
	if (which("zenity")) return { exe: "zenity", args: ["--file-selection", "--directory", `--title=${title}`, ...(start ? [`--filename=${start.endsWith("/") ? start : `${start}/`}`] : [])], env };
	if (which("kdialog")) return { exe: "kdialog", args: ["--getexistingdirectory", start || ".", "--title", title], env };
	throw unsupported("이 환경에서는 폴더 선택 창을 열 수 없습니다 (zenity 또는 kdialog 필요)");
}

let current = null;

/** @param signal AbortSignal – kills the dialog process when the browser request goes away */
export function pickFolderNative({ start = "", title = "프로젝트 폴더 선택", signal } = {}) {
	if (current) {
		const err = new Error("폴더 선택 창이 이미 열려 있습니다");
		err.code = "BUSY";
		return Promise.reject(err);
	}
	// Test seam: PI_WEB_TEST_PICK=<path> answers instantly, "cancel" simulates Cancel.
	if (process.env.PI_WEB_TEST_PICK) return Promise.resolve(process.env.PI_WEB_TEST_PICK === "cancel" ? { cancelled: true } : { path: process.env.PI_WEB_TEST_PICK });
	let cmd;
	try {
		cmd = buildCommand(start, title);
	} catch (err) {
		return Promise.reject(err);
	}
	current = new Promise((resolve, reject) => {
		const child = spawn(cmd.exe, cmd.args, { env: cmd.env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let errOut = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (errOut += d));
		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err.code === "ENOENT" ? unsupported("폴더 선택 창을 실행할 수 없습니다") : err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const picked = out.replace(/^\uFEFF/, "").trim();
			if (picked) return resolve({ path: picked.length > 3 ? picked.replace(/[\\/]+$/, "") : picked });
			if (code === 0 || code === 1) return resolve({ cancelled: true }); // zenity/kdialog exit 1 on cancel
			reject(new Error(errOut.trim().split("\n")[0] || `폴더 선택 창 오류 (코드 ${code})`));
		});
	}).finally(() => {
		current = null;
	});
	return current;
}

export function nativePickerAvailable() {
	if (process.env.PI_WEB_TEST_PICK) return true;
	if (process.platform === "win32" || process.platform === "darwin") return true;
	return which("zenity") || which("kdialog");
}
