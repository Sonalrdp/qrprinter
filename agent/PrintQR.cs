using System;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Diagnostics;
using System.Threading;
using System.Windows.Forms;

public class PrintQRApp {
    [STAThread]
    public static void Main(string[] args) {
        try {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288 | SecurityProtocolType.Tls;
            ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
        } catch {}

        // Determine installation / application directory
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        if (!File.Exists(Path.Combine(appDir, "agent.js"))) {
            // Check standard installation location
            string progFiles = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PrintQR-Agent");
            if (File.Exists(Path.Combine(progFiles, "agent.js"))) {
                appDir = progFiles;
            }
        }

        Directory.SetCurrentDirectory(appDir);

        // Read server URL
        string serverUrl = "";
        string urlFile = Path.Combine(appDir, "server_url.txt");
        if (File.Exists(urlFile)) {
            serverUrl = File.ReadAllText(urlFile).Trim();
        }

        // Auto-check and apply update on every startup
        if (!string.IsNullOrEmpty(serverUrl)) {
            CheckAndApplyUpdates(appDir, serverUrl);
        }

        // Find node.exe
        string nodeExe = FindNodeExecutable(appDir);
        if (string.IsNullOrEmpty(nodeExe)) {
            MessageBox.Show(
                "Node.js was not detected on this system.\n\nPlease install Node.js LTS from https://nodejs.org or run PrintQR_Setup.exe again.",
                "PrintQR Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning
            );
            return;
        }

        // Kill any previous stale agent running on port 4010
        KillProcessOnPort(4010);

        // Start background Node agent process (Completely hidden - zero CMD window)
        Process nodeProc = new Process();
        nodeProc.StartInfo.FileName = nodeExe;
        nodeProc.StartInfo.Arguments = "agent.js --managed";
        nodeProc.StartInfo.WorkingDirectory = appDir;
        nodeProc.StartInfo.CreateNoWindow = true;
        nodeProc.StartInfo.WindowStyle = ProcessWindowStyle.Hidden;
        nodeProc.StartInfo.UseShellExecute = false;

        try {
            nodeProc.Start();
        } catch (Exception ex) {
            MessageBox.Show("Failed to start PrintQR background agent: " + ex.Message, "PrintQR Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        // Wait until agent web server is responding (up to 6 seconds)
        bool ready = false;
        for (int i = 0; i < 30; i++) {
            Thread.Sleep(200);
            if (IsPortListening("http://127.0.0.1:4010/local/state")) {
                ready = true;
                break;
            }
        }

        if (!ready && nodeProc.HasExited) {
            MessageBox.Show("PrintQR agent failed to initialize. Please check network/printer drivers.", "PrintQR Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        // Find Microsoft Edge executable for native app window
        string edgePath = FindEdgeExecutable();
        string profileDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PrintQR-Agent", "AppProfile");
        try { Directory.CreateDirectory(profileDir); } catch {}

        Process appWindowProc = null;
        if (!string.IsNullOrEmpty(edgePath)) {
            appWindowProc = new Process();
            appWindowProc.StartInfo.FileName = edgePath;
            appWindowProc.StartInfo.Arguments = "--app=http://127.0.0.1:4010 --window-size=1150,820 --user-data-dir=\"" + profileDir + "\"";
            appWindowProc.StartInfo.UseShellExecute = false;
            try {
                appWindowProc.Start();
            } catch {
                appWindowProc = null;
            }
        }

        // Fallback to default browser if Edge app mode couldn't launch
        if (appWindowProc == null) {
            try {
                appWindowProc = Process.Start("http://127.0.0.1:4010");
            } catch {}
        }

        // Monitor app window: when user closes the app, auto-close the background agent!
        if (appWindowProc != null && !appWindowProc.HasExited) {
            try {
                appWindowProc.WaitForExit();
            } catch {}
        } else {
            // If process handle detached immediately, wait for node process or shutdown beacon
            while (!nodeProc.HasExited) {
                Thread.Sleep(1000);
            }
        }

        // Auto close and kill background node process
        try {
            if (!nodeProc.HasExited) {
                // Send graceful shutdown beacon
                try {
                    WebRequest req = WebRequest.Create("http://127.0.0.1:4010/local/shutdown");
                    req.Timeout = 500;
                    req.GetResponse();
                } catch {}
                Thread.Sleep(300);
                if (!nodeProc.HasExited) {
                    nodeProc.Kill();
                }
            }
        } catch {}
    }

    private static string FindNodeExecutable(string appDir) {
        string localNode = Path.Combine(appDir, "node.exe");
        if (File.Exists(localNode)) return localNode;

        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pfNode = Path.Combine(pf, "nodejs", "node.exe");
        if (File.Exists(pfNode)) return pfNode;

        string pfx86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string pfxNode = Path.Combine(pfx86, "nodejs", "node.exe");
        if (File.Exists(pfxNode)) return pfxNode;

        // Check PATH
        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string rawDir in pathEnv.Split(';')) {
            string dir = rawDir.Trim();
            if (string.IsNullOrEmpty(dir)) continue;
            try {
                string cand = Path.Combine(dir, "node.exe");
                if (File.Exists(cand)) return cand;
            } catch {}
        }
        return null;
    }

    private static string FindEdgeExecutable() {
        string[] candidates = new string[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
        };
        foreach (string c in candidates) {
            if (File.Exists(c)) return c;
        }
        return null;
    }

    private static bool IsPortListening(string url) {
        try {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 400;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse()) {
                return resp.StatusCode == HttpStatusCode.OK;
            }
        } catch {
            return false;
        }
    }

    private static void KillProcessOnPort(int port) {
        try {
            Process p = new Process();
            p.StartInfo.FileName = "cmd.exe";
            p.StartInfo.Arguments = "/c netstat -ano | findstr :" + port;
            p.StartInfo.RedirectStandardOutput = true;
            p.StartInfo.UseShellExecute = false;
            p.StartInfo.CreateNoWindow = true;
            p.Start();
            string output = p.StandardOutput.ReadToEnd();
            p.WaitForExit(1000);

            string[] lines = output.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string line in lines) {
                if (line.Contains("LISTENING")) {
                    string[] parts = line.Trim().Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 5) {
                        int pid;
                        if (int.TryParse(parts[parts.Length - 1], out pid) && pid > 0 && pid != Process.GetCurrentProcess().Id) {
                            try {
                                Process stale = Process.GetProcessById(pid);
                                stale.Kill();
                            } catch {}
                        }
                    }
                }
            }
        } catch {}
    }

    private static void CheckAndApplyUpdates(string appDir, string serverUrl) {
        try {
            string verFile = Path.Combine(appDir, "version.txt");
            string localVersion = File.Exists(verFile) ? File.ReadAllText(verFile).Trim() : "1.0.0";

            string checkUrl = serverUrl.TrimEnd('/') + "/api/agent/version";
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(checkUrl);
            req.Headers.Add("ngrok-skip-browser-warning", "true");
            req.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PrintQR-App";
            req.Timeout = 3000;
            req.ReadWriteTimeout = 3000;
            string json = "";
            using (WebResponse resp = req.GetResponse())
            using (StreamReader sr = new StreamReader(resp.GetResponseStream())) {
                json = sr.ReadToEnd();
            }

            string remoteVer = ExtractJsonString(json, "version");
            string dlPath = ExtractJsonString(json, "downloadUrl");
            if (string.IsNullOrEmpty(dlPath)) dlPath = "/downloads/PrintQR-Agent.zip";

            if (!string.IsNullOrEmpty(remoteVer) && remoteVer != localVersion) {
                string tempZip = Path.Combine(Path.GetTempPath(), "pqr_update_" + Guid.NewGuid().ToString("N") + ".zip");
                using (WebClient wc = new WebClient()) {
                    wc.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PrintQR-App");
                    wc.Headers.Add("ngrok-skip-browser-warning", "true");
                    string fullDlUrl = dlPath.StartsWith("http") ? dlPath : (serverUrl.TrimEnd('/') + dlPath);
                    wc.DownloadFile(fullDlUrl, tempZip);
                }

                if (File.Exists(tempZip)) {
                    ExtractZipOverwriting(tempZip, appDir);
                    File.WriteAllText(verFile, remoteVer);
                    try { File.Delete(tempZip); } catch {}
                }
            }
        } catch {
            // Silently proceed if server is unreachable or offline
        }
    }

    private static void ExtractZipOverwriting(string zipPath, string targetDir) {
        using (ZipArchive archive = ZipFile.OpenRead(zipPath)) {
            foreach (ZipArchiveEntry entry in archive.Entries) {
                if (string.IsNullOrEmpty(entry.Name)) continue;
                string rel = entry.FullName;
                if (rel.StartsWith("PrintQR-Agent/", StringComparison.OrdinalIgnoreCase)) {
                    rel = rel.Substring("PrintQR-Agent/".Length);
                }
                if (string.IsNullOrEmpty(rel)) continue;
                // Avoid overwriting currently running executable to prevent lock error
                if (rel.EndsWith("PrintQR.exe", StringComparison.OrdinalIgnoreCase)) continue;

                string dest = Path.Combine(targetDir, rel.Replace('/', Path.DirectorySeparatorChar));
                string dir = Path.GetDirectoryName(dest);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) {
                    Directory.CreateDirectory(dir);
                }
                entry.ExtractToFile(dest, true);
            }
        }
    }

    private static string ExtractJsonString(string json, string key) {
        try {
            string pattern = "\"" + key + "\"";
            int idx = json.IndexOf(pattern);
            if (idx < 0) return null;
            int colon = json.IndexOf(':', idx + pattern.Length);
            if (colon < 0) return null;
            int q1 = json.IndexOf('"', colon + 1);
            if (q1 < 0) return null;
            int q2 = json.IndexOf('"', q1 + 1);
            if (q2 < 0) return null;
            return json.Substring(q1 + 1, q2 - q1 - 1);
        } catch {
            return null;
        }
    }
}
