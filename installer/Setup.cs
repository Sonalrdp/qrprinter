using System;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Diagnostics;
using System.Threading;
using System.Security.Principal;
using System.Windows.Forms;
using System.Drawing;
using System.Reflection;

public class PrintQRSetup : Form {
    private Label lblTitle;
    private Label lblSub;
    private Label lblPath;
    private Label lblStatus;
    private ProgressBar progress;
    private CheckBox chkLaunch;
    private Button btnAction;
    private Button btnCancel;
    private string serverUrl = "http://localhost:3000";
    private readonly string targetDir = @"C:\Program Files\PrintQR-Agent";
    private bool isInstalled = false;

    public PrintQRSetup() {
        try {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288 | SecurityProtocolType.Tls;
        } catch {}
        InitializeUI();
        LoadConfiguredServerUrl();
    }

    [STAThread]
    public static void Main(string[] args) {
        try {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288 | SecurityProtocolType.Tls;
        } catch {}

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new PrintQRSetup());
    }

    private void LoadConfiguredServerUrl() {
        try {
            // 1. Check server_url.txt in the same directory as this setup exe
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string localTxt = Path.Combine(appDir, "server_url.txt");
            if (File.Exists(localTxt)) {
                string u = File.ReadAllText(localTxt).Trim();
                if (!string.IsNullOrEmpty(u)) { serverUrl = u; return; }
            }

            // 2. Check config.json in the same directory
            string localCfg = Path.Combine(appDir, "config.json");
            if (File.Exists(localCfg)) {
                string u = ExtractJsonString(File.ReadAllText(localCfg), "serverUrl");
                if (!string.IsNullOrEmpty(u)) { serverUrl = u; return; }
            }

            // 3. Check embedded configuration marker if present
            string self = Assembly.GetExecutingAssembly().Location;
            byte[] bytes = File.ReadAllBytes(self);
            string text = System.Text.Encoding.UTF8.GetString(bytes);
            string marker = "---PRINTQR_CONFIG---";
            int idx = text.LastIndexOf(marker);
            if (idx >= 0) {
                string payload = text.Substring(idx + marker.Length).Trim();
                string parsedUrl = ExtractJsonString(payload, "serverUrl");
                if (!string.IsNullOrEmpty(parsedUrl)) {
                    serverUrl = parsedUrl;
                    return;
                }
            }
        } catch {}
    }

    private void InitializeUI() {
        this.Text = "PrintQR Agent Setup";
        this.Width = 520;
        this.Height = 350;
        this.StartPosition = FormStartPosition.CenterScreen;
        this.FormBorderStyle = FormBorderStyle.FixedDialog;
        this.MaximizeBox = false;
        this.MinimizeBox = true;
        this.BackColor = Color.FromArgb(241, 242, 238); // PrintQR paper color
        this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

        // Header Panel
        Panel pnlHeader = new Panel();
        pnlHeader.Dock = DockStyle.Top;
        pnlHeader.Height = 85;
        pnlHeader.BackColor = Color.FromArgb(24, 27, 38); // PrintQR ink color

        lblTitle = new Label();
        lblTitle.Text = "Install PrintQR Agent";
        lblTitle.ForeColor = Color.White;
        lblTitle.Font = new Font("Segoe UI", 15f, FontStyle.Bold);
        lblTitle.Location = new Point(24, 16);
        lblTitle.AutoSize = true;
        pnlHeader.Controls.Add(lblTitle);

        lblSub = new Label();
        lblSub.Text = "Automated print spooler for your shop counter";
        lblSub.ForeColor = Color.FromArgb(180, 184, 195);
        lblSub.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
        lblSub.Location = new Point(25, 48);
        lblSub.AutoSize = true;
        pnlHeader.Controls.Add(lblSub);

        this.Controls.Add(pnlHeader);

        // Main controls
        lblPath = new Label();
        lblPath.Text = "Destination:  " + targetDir;
        lblPath.Location = new Point(25, 105);
        lblPath.ForeColor = Color.FromArgb(40, 40, 40);
        lblPath.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
        lblPath.AutoSize = true;
        this.Controls.Add(lblPath);

        lblStatus = new Label();
        lblStatus.Text = "Ready to download and install.";
        lblStatus.Location = new Point(25, 140);
        lblStatus.Size = new Size(455, 36);
        lblStatus.ForeColor = Color.FromArgb(80, 85, 95);
        this.Controls.Add(lblStatus);

        progress = new ProgressBar();
        progress.Location = new Point(25, 185);
        progress.Size = new Size(455, 22);
        progress.Style = ProgressBarStyle.Continuous;
        progress.Value = 0;
        this.Controls.Add(progress);

        chkLaunch = new CheckBox();
        chkLaunch.Text = "Launch PrintQR Agent after installation";
        chkLaunch.Checked = true;
        chkLaunch.Location = new Point(26, 225);
        chkLaunch.AutoSize = true;
        this.Controls.Add(chkLaunch);

        // Buttons
        btnAction = new Button();
        btnAction.Text = "Install";
        btnAction.Size = new Size(130, 36);
        btnAction.Location = new Point(220, 260);
        btnAction.BackColor = Color.FromArgb(24, 27, 38);
        btnAction.ForeColor = Color.White;
        btnAction.FlatStyle = FlatStyle.Flat;
        btnAction.FlatAppearance.BorderSize = 0;
        btnAction.Cursor = Cursors.Hand;
        btnAction.Click += new EventHandler(BtnAction_Click);
        this.Controls.Add(btnAction);

        btnCancel = new Button();
        btnCancel.Text = "Cancel";
        btnCancel.Size = new Size(110, 36);
        btnCancel.Location = new Point(365, 260);
        btnCancel.BackColor = Color.Transparent;
        btnCancel.ForeColor = Color.FromArgb(24, 27, 38);
        btnCancel.FlatStyle = FlatStyle.Flat;
        btnCancel.FlatAppearance.BorderColor = Color.FromArgb(200, 200, 200);
        btnCancel.Cursor = Cursors.Hand;
        btnCancel.Click += (s, e) => this.Close();
        this.Controls.Add(btnCancel);
    }

    private void SetStatus(string text, int percent) {
        if (this.InvokeRequired) {
            this.Invoke(new Action(() => SetStatus(text, percent)));
            return;
        }
        lblStatus.Text = text;
        if (percent >= 0 && percent <= 100) {
            progress.Value = percent;
        }
    }

    private void BtnAction_Click(object sender, EventArgs e) {
        if (isInstalled) {
            // Finish & Launch
            if (chkLaunch.Checked) {
                string exePath = Path.Combine(targetDir, "PrintQR.exe");
                if (File.Exists(exePath)) {
                    Process.Start(new ProcessStartInfo(exePath) { UseShellExecute = true });
                }
            }
            this.Close();
            return;
        }

        btnAction.Enabled = false;
        btnCancel.Enabled = false;
        progress.Style = ProgressBarStyle.Marquee;

        Thread installThread = new Thread(RunInstallation);
        installThread.IsBackground = true;
        installThread.Start();
    }

    private void RunInstallation() {
        try {
            // 1. Create directory
            SetStatus("Creating destination directory: " + targetDir, 10);
            if (!Directory.Exists(targetDir)) {
                Directory.CreateDirectory(targetDir);
            }

            // 2. Check Node.js
            SetStatus("Checking Node.js environment...", 20);
            string nodePath = FindNode();
            if (string.IsNullOrEmpty(nodePath)) {
                SetStatus("Installing Node.js via winget...", 25);
                try {
                    Process pWinget = new Process();
                    pWinget.StartInfo.FileName = "winget";
                    pWinget.StartInfo.Arguments = "install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements";
                    pWinget.StartInfo.CreateNoWindow = true;
                    pWinget.StartInfo.UseShellExecute = false;
                    pWinget.Start();
                    pWinget.WaitForExit(90000);
                } catch {}
            }

            // 3. Download PrintQR-Agent.zip
            SetStatus("Downloading latest application files from " + serverUrl + "...", 40);
            string zipUrl = serverUrl.TrimEnd('/') + "/downloads/PrintQR-Agent.zip";
            string tempZip = Path.Combine(Path.GetTempPath(), "PrintQR_Agent_Setup_" + Guid.NewGuid().ToString("N") + ".zip");

            bool downloaded = false;
            try {
                using (WebClient wc = new WebClient()) {
                    wc.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PrintQR-Installer");
                    wc.Headers.Add("ngrok-skip-browser-warning", "true");
                    wc.DownloadFile(zipUrl, tempZip);
                    downloaded = true;
                }
            } catch (Exception dlEx) {
                // Check if local PrintQR-Agent.zip is available next to setup exe or in workspace
                string[] fallbacks = new string[] {
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "PrintQR-Agent.zip"),
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "downloads", "PrintQR-Agent.zip"),
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "server", "public", "downloads", "PrintQR-Agent.zip")
                };
                foreach (string fb in fallbacks) {
                    if (File.Exists(fb)) {
                        File.Copy(fb, tempZip, true);
                        downloaded = true;
                        break;
                    }
                }
                if (!downloaded) {
                    throw dlEx;
                }
            }

            // 4. Extract into C:\Program Files\PrintQR-Agent
            SetStatus("Extracting files to " + targetDir + "...", 65);
            using (ZipArchive archive = ZipFile.OpenRead(tempZip)) {
                foreach (ZipArchiveEntry entry in archive.Entries) {
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    string rel = entry.FullName;
                    if (rel.StartsWith("PrintQR-Agent/", StringComparison.OrdinalIgnoreCase)) {
                        rel = rel.Substring("PrintQR-Agent/".Length);
                    }
                    if (string.IsNullOrEmpty(rel)) continue;

                    string dest = Path.Combine(targetDir, rel.Replace('/', Path.DirectorySeparatorChar));
                    string dir = Path.GetDirectoryName(dest);
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) {
                        Directory.CreateDirectory(dir);
                    }
                    entry.ExtractToFile(dest, true);
                }
            }

            try { File.Delete(tempZip); } catch {}

            // 5. Write server_url.txt and version.txt
            File.WriteAllText(Path.Combine(targetDir, "server_url.txt"), serverUrl);
            File.WriteAllText(Path.Combine(targetDir, "version.txt"), "1.0.1");

            // 6. Ensure npm dependencies if missing
            if (!Directory.Exists(Path.Combine(targetDir, "node_modules", "pdf-to-printer"))) {
                SetStatus("Configuring printer drivers (running npm install)...", 80);
                string node = FindNode();
                string npmCmd = FindNpm();
                if (!string.IsNullOrEmpty(npmCmd)) {
                    Process npmP = new Process();
                    npmP.StartInfo.FileName = "cmd.exe";
                    npmP.StartInfo.Arguments = "/c \"" + npmCmd + "\" install --no-audit --no-fund";
                    npmP.StartInfo.WorkingDirectory = targetDir;
                    npmP.StartInfo.CreateNoWindow = true;
                    npmP.StartInfo.UseShellExecute = false;
                    npmP.Start();
                    npmP.WaitForExit(60000);
                }
            }

            // 7. Create Desktop Shortcut and Desktop .exe
            SetStatus("Creating Desktop shortcut and launcher...", 92);
            string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string exeSource = Path.Combine(targetDir, "PrintQR.exe");

            // Direct .exe on Desktop
            if (File.Exists(exeSource)) {
                try {
                    File.Copy(exeSource, Path.Combine(desktopDir, "PrintQR Agent.exe"), true);
                } catch {}
            }

            // .lnk shortcut on Desktop
            CreateShortcut(
                Path.Combine(desktopDir, "PrintQR Agent.lnk"),
                exeSource,
                targetDir,
                "PrintQR Agent for shop counter printing"
            );

            // Start Menu shortcut
            string commonPrograms = Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms);
            if (Directory.Exists(commonPrograms)) {
                CreateShortcut(
                    Path.Combine(commonPrograms, "PrintQR Agent.lnk"),
                    exeSource,
                    targetDir,
                    "PrintQR Agent for shop counter printing"
                );
            }

            // Complete
            this.Invoke(new Action(() => {
                progress.Style = ProgressBarStyle.Continuous;
                progress.Value = 100;
                lblStatus.ForeColor = Color.FromArgb(31, 122, 71);
                lblStatus.Text = "✓ Installation successful!\nFiles installed in " + targetDir;
                btnAction.Text = "Finish & Launch";
                btnAction.BackColor = Color.FromArgb(31, 122, 71);
                btnAction.Enabled = true;
                btnCancel.Visible = false;
                isInstalled = true;
            }));

        } catch (Exception ex) {
            this.Invoke(new Action(() => {
                progress.Style = ProgressBarStyle.Continuous;
                progress.Value = 0;
                lblStatus.ForeColor = Color.FromArgb(197, 34, 31);
                lblStatus.Text = "Installation failed: " + ex.Message;
                btnAction.Text = "Retry";
                btnAction.Enabled = true;
                btnCancel.Enabled = true;
            }));
        }
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workDir, string desc) {
        try {
            Type t = Type.GetTypeFromCLSID(new Guid("72C24DD5-D70A-438B-84D2-9564077592B2")); // WScript.Shell
            dynamic shell = Activator.CreateInstance(t);
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = targetPath;
            shortcut.WorkingDirectory = workDir;
            shortcut.Description = desc;
            shortcut.Save();
        } catch {}
    }

    private static string FindNode() {
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string c1 = Path.Combine(pf, "nodejs", "node.exe");
        if (File.Exists(c1)) return c1;

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

    private static string FindNpm() {
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string c1 = Path.Combine(pf, "nodejs", "npm.cmd");
        if (File.Exists(c1)) return c1;

        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string rawDir in pathEnv.Split(';')) {
            string dir = rawDir.Trim();
            if (string.IsNullOrEmpty(dir)) continue;
            try {
                string cand = Path.Combine(dir, "npm.cmd");
                if (File.Exists(cand)) return cand;
            } catch {}
        }
        return null;
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

