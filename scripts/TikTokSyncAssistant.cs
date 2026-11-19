using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace TikTokSyncAssistant
{
    public class Config
    {
        public string rootDir { get; set; }
        public string sellerCenterUrl { get; set; }
        public int exportLookbackDays { get; set; }
        public SyncRules syncRules { get; set; }
        public List<Shop> shopMappings { get; set; }
        public Config() { shopMappings = new List<Shop>(); }
    }
    public class SyncRules { public int orders { get; set; } public int settledBills { get; set; } public int unsettledBills { get; set; } public int promotions { get; set; } }

    public class Shop
    {
        public string sellerCenterName { get; set; }
        public string countryCode { get; set; }
        public string systemShopId { get; set; }
        public string systemShopName { get; set; }
        public string systemShopCode { get; set; }
        public string profileKey { get; set; }
        public bool automationEnabled { get; set; }
        public string verifiedAt { get; set; }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // 由自动同步脚本在当前 Windows 用户上下文中读取凭据。密码始终以
            // DPAPI 加密形式落盘，且只通过标准输出短暂传给本机子进程。
            if (args != null && args.Length == 2 && String.Equals(args[0], "--credentials", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    Console.OutputEncoding = Encoding.UTF8;
                    Console.Write(new JavaScriptSerializer().Serialize(CredentialVault.ForAutomation(args[1])));
                    Environment.ExitCode = 0;
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine(error.Message);
                    Environment.ExitCode = 1;
                }
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    public class SavedCredential
    {
        public string username { get; set; }
        public string passwordProtected { get; set; }
        public string updatedAt { get; set; }
    }

    public class CredentialStore
    {
        public Dictionary<string, SavedCredential> shops { get; set; }
        public CredentialStore() { shops = new Dictionary<string, SavedCredential>(StringComparer.OrdinalIgnoreCase); }
    }

    public static class CredentialVault
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();
        private static readonly string StorePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TikTokProfitSyncAssistant", "seller-credentials.json");

        private static byte[] Entropy(string profileKey) { return Encoding.UTF8.GetBytes("TikTokSyncAssistant/" + (profileKey ?? "default")); }
        private static CredentialStore Load()
        {
            try
            {
                var value = Serializer.Deserialize<CredentialStore>(File.ReadAllText(StorePath, Encoding.UTF8));
                if (value == null) value = new CredentialStore();
                if (value.shops == null) value.shops = new Dictionary<string, SavedCredential>(StringComparer.OrdinalIgnoreCase);
                return value;
            }
            catch (FileNotFoundException) { return new CredentialStore(); }
            catch (DirectoryNotFoundException) { return new CredentialStore(); }
        }
        private static void Save(CredentialStore store)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StorePath));
            var temporary = StorePath + ".tmp";
            File.WriteAllText(temporary, Serializer.Serialize(store), Encoding.UTF8);
            if (File.Exists(StorePath)) File.Delete(StorePath);
            File.Move(temporary, StorePath);
        }
        public static bool HasCredentials(string profileKey)
        {
            SavedCredential value;
            return Load().shops.TryGetValue(profileKey ?? "default", out value) && value != null && !String.IsNullOrWhiteSpace(value.username) && !String.IsNullOrWhiteSpace(value.passwordProtected);
        }
        public static string Username(string profileKey)
        {
            SavedCredential value;
            return Load().shops.TryGetValue(profileKey ?? "default", out value) && value != null ? value.username ?? "" : "";
        }
        public static void Set(string profileKey, string username, string password)
        {
            if (String.IsNullOrWhiteSpace(username) || String.IsNullOrWhiteSpace(password)) throw new Exception("账号和密码都不能为空。");
            var key = profileKey ?? "default";
            var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(password), Entropy(key), DataProtectionScope.CurrentUser);
            var store = Load();
            store.shops[key] = new SavedCredential { username = username.Trim(), passwordProtected = Convert.ToBase64String(encrypted), updatedAt = DateTime.UtcNow.ToString("o") };
            Save(store);
        }
        public static void Remove(string profileKey)
        {
            var store = Load();
            if (store.shops.Remove(profileKey ?? "default")) Save(store);
        }
        public static object ForAutomation(string profileKey)
        {
            var key = profileKey ?? "default";
            SavedCredential value;
            if (!Load().shops.TryGetValue(key, out value) || value == null || String.IsNullOrWhiteSpace(value.username) || String.IsNullOrWhiteSpace(value.passwordProtected)) return new { configured = false };
            var encrypted = Convert.FromBase64String(value.passwordProtected);
            var password = Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, Entropy(key), DataProtectionScope.CurrentUser));
            return new { configured = true, username = value.username, password = password };
        }
    }

    public class MainForm : Form
    {
        private readonly string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tiktok-automation.config.json");
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private Config config;
        private readonly DataGridView grid = new DataGridView();
        private readonly Label status = new Label();
        private readonly Label authStatus = new Label();
        private readonly Timer statusTimer = new Timer();
        private readonly NumericUpDown lookbackDays = new NumericUpDown();
        private readonly NumericUpDown settledDays = new NumericUpDown();
        private readonly NumericUpDown unsettledDays = new NumericUpDown();
        private readonly NumericUpDown promotionDays = new NumericUpDown();
        private readonly MaskedTextBox runTime = new MaskedTextBox("00:00");
        private readonly TextBox runStatus = new TextBox();
        private Process activeRunner;

        public MainForm()
        {
            Text = "TikTok Shop 自动同步助手";
            Size = new Size(980, 780);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(244, 247, 251);
            Font = new Font("Microsoft YaHei UI", 9);
            MaximizeBox = false;

            var header = new Panel { Dock = DockStyle.Top, Height = 108, BackColor = Color.FromArgb(19, 38, 67) };
            header.Controls.Add(new Label { Text = "TikTok Shop 利润测算 · 自动同步助手", ForeColor = Color.White, Font = new Font("Microsoft YaHei UI", 16, FontStyle.Bold), Location = new Point(28, 22), AutoSize = true });
            header.Controls.Add(new Label { Text = "店铺管理  /  账号管理  /  定时下载  /  安全校验  /  自动导入", ForeColor = Color.FromArgb(156, 207, 230), Location = new Point(31, 62), AutoSize = true });
            Controls.Add(header);

            var card = new Panel { BackColor = Color.White, Location = new Point(24, 128), Size = new Size(916, 370) };
            card.Controls.Add(new Label { Text = "店铺管理", Font = new Font("Microsoft YaHei UI", 12, FontStyle.Bold), Location = new Point(22, 18), AutoSize = true });
            card.Controls.Add(new Label { Text = "勾选需要自动化的店铺。每家店铺使用独立 Chrome 登录配置；首次登录后会自动复用登录状态。", ForeColor = Color.FromArgb(90, 110, 130), Location = new Point(22, 47), AutoSize = true });
            ConfigureGrid();
            grid.CurrentCellDirtyStateChanged += delegate { if (grid.IsCurrentCellDirty) grid.CommitEdit(DataGridViewDataErrorContexts.Commit); };
            grid.CellValueChanged += delegate(object sender, DataGridViewCellEventArgs args)
            {
                if (args.ColumnIndex == 0 && args.RowIndex >= 0)
                {
                    var selected = grid.Rows.Cast<DataGridViewRow>().Count(row => Convert.ToBoolean(row.Cells[0].Value));
                    status.Text = "已选择 " + selected + " 家店铺，点击“确认并保存设置”后生效";
                }
            };
            grid.Location = new Point(22, 78); grid.Size = new Size(872, 210); card.Controls.Add(grid);
            card.Controls.Add(Button("＋ 添加店铺", 22, AddShop, true));
            card.Controls.Add(Button("打开登录", 146, OpenLogin));
            card.Controls.Add(Button("删除", 252, DeleteShop));
            card.Controls.Add(Button("系统授权登录", 358, AuthorizeSystem, true));
            card.Controls.Add(Button("账号管理", 488, ManageAccounts, true));
            card.Controls.Add(Button("全选", 602, SelectAllShops));
            card.Controls.Add(Button("反选", 704, InvertShopSelection));
            Controls.Add(card);

            var bottom = new Panel { BackColor = Color.White, Location = new Point(24, 516), Size = new Size(916, 134) };
            bottom.Controls.Add(new Label { Text = "每日运行时间", Location = new Point(22, 16), AutoSize = true });
            runTime.Location = new Point(22, 42); runTime.Width = 88; runTime.Text = "09:30"; runTime.TextAlign = HorizontalAlignment.Center;
            bottom.Controls.Add(runTime);
            status.Location = new Point(132, 46); status.AutoSize = true; status.ForeColor = Color.FromArgb(70, 101, 125); bottom.Controls.Add(status);
            authStatus.Location = new Point(132, 68); authStatus.Size = new Size(430, 22); authStatus.AutoEllipsis = true; authStatus.AutoSize = false; authStatus.ForeColor = Color.FromArgb(70, 101, 125); bottom.Controls.Add(authStatus);
            bottom.Controls.Add(new Label { Text = "订单", Location = new Point(250, 16), AutoSize = true });
            bottom.Controls.Add(new Label { Text = "已结算", Location = new Point(340, 16), AutoSize = true });
            bottom.Controls.Add(new Label { Text = "未结算", Location = new Point(430, 16), AutoSize = true });
            bottom.Controls.Add(new Label { Text = "推广", Location = new Point(520, 16), AutoSize = true });
            foreach(var picker in new [] { lookbackDays, settledDays, unsettledDays, promotionDays }) { picker.Minimum = 1; picker.Maximum = 31; picker.Width = 52; picker.Value = 1; bottom.Controls.Add(picker); }
            lookbackDays.Location = new Point(250, 42); settledDays.Location = new Point(340, 42); unsettledDays.Location = new Point(430, 42); promotionDays.Location = new Point(520, 42);
            bottom.Controls.Add(new Label { Text = "订单为前 N 天（不含今天）", Location = new Point(585, 46), AutoSize = true, ForeColor = Color.FromArgb(70, 101, 125) });
            bottom.Controls.Add(new Label { Text = "当前自动同步订单、已结算、未结算与推广日报；所有日期按 UTC 前 N 天筛选", Location = new Point(22, 102), AutoSize = true, ForeColor = Color.FromArgb(70, 101, 125) });
            var check = new Button { Text = "运行前检测", Location = new Point(492, 68), Size = new Size(104, 28), FlatStyle = FlatStyle.Flat }; check.Click += RunPreflight; bottom.Controls.Add(check);
            var rangeRun = new Button { Text = "按日期范围同步", Location = new Point(604, 68), Size = new Size(132, 28), FlatStyle = FlatStyle.Flat }; rangeRun.Click += RunDateRange; bottom.Controls.Add(rangeRun);
            var runNow = new Button { Text = "立即串行同步", Location = new Point(744, 68), Size = new Size(136, 28), FlatStyle = FlatStyle.Flat }; runNow.Click += RunNow; bottom.Controls.Add(runNow);
            var save = new Button { Text = "确认并保存设置", Location = new Point(748, 34), Size = new Size(132, 30), BackColor = Color.FromArgb(27, 157, 190), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, FlatAppearance = { BorderSize = 0 } }; save.Click += ConfirmSettings; bottom.Controls.Add(save);
            Controls.Add(bottom);

            var runCard = new Panel { BackColor = Color.White, Location = new Point(24, 666), Size = new Size(916, 92) };
            runCard.Controls.Add(new Label { Text = "运行状态", Font = new Font("Microsoft YaHei UI", 10, FontStyle.Bold), Location = new Point(22, 14), AutoSize = true });
            var runResult = new Button { Text = "运行结果", Location = new Point(642, 10), Size = new Size(122, 28), BackColor = Color.FromArgb(27, 157, 190), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, FlatAppearance = { BorderSize = 0 } }; runResult.Click += ShowLastRunResult; runCard.Controls.Add(runResult);
            var stopRun = new Button { Text = "停止当前任务", Location = new Point(772, 10), Size = new Size(122, 28), FlatStyle = FlatStyle.Flat }; stopRun.Click += CancelCurrentRun; runCard.Controls.Add(stopRun);
            runStatus.Location = new Point(22, 38); runStatus.Size = new Size(872, 40); runStatus.Multiline = true; runStatus.ReadOnly = true; runStatus.ScrollBars = ScrollBars.Vertical; runStatus.BorderStyle = BorderStyle.FixedSingle; runStatus.BackColor = Color.FromArgb(248, 251, 253); runStatus.ForeColor = Color.FromArgb(60, 85, 110); runCard.Controls.Add(runStatus);
            Controls.Add(runCard);

            try { LoadConfig(); } catch (Exception ex) { MessageBox.Show(ex.Message, "无法加载店铺配置"); }
            statusTimer.Interval = 3000;
            statusTimer.Tick += delegate { RefreshShopLoginStatuses(); RefreshAuthorizationStatus(); RefreshRunStatus(); };
            statusTimer.Start();
            RefreshRunStatus();
        }

        private Button Button(string text, int x, EventHandler click, bool primary = false)
        {
            var button = new Button { Text = text, Location = new Point(x, 310), Size = new Size(text.Contains("添加") ? 112 : (text.Contains("授权") ? 120 : (text.Contains("账号") ? 102 : 94)), 34), FlatStyle = FlatStyle.Flat };
            if (primary) { button.BackColor = Color.FromArgb(27, 157, 190); button.ForeColor = Color.White; }
            button.Click += click; return button;
        }

        private void SelectAllShops(object sender, EventArgs eventArgs)
        {
            if (grid.Rows.Count == 0) { status.Text = "暂无可选择店铺"; return; }
            grid.EndEdit();
            grid.SuspendLayout();
            foreach (DataGridViewRow row in grid.Rows) row.Cells[0].Value = true;
            grid.ResumeLayout();
            status.Text = "已全选 " + grid.Rows.Count + " 家店铺，点击“确认并保存设置”后生效";
        }

        private void InvertShopSelection(object sender, EventArgs eventArgs)
        {
            if (grid.Rows.Count == 0) { status.Text = "暂无可选择店铺"; return; }
            grid.EndEdit();
            grid.SuspendLayout();
            foreach (DataGridViewRow row in grid.Rows) row.Cells[0].Value = !Convert.ToBoolean(row.Cells[0].Value ?? false);
            grid.ResumeLayout();
            var selected = grid.Rows.Cast<DataGridViewRow>().Count(row => Convert.ToBoolean(row.Cells[0].Value ?? false));
            status.Text = "已反选，当前选择 " + selected + " 家店铺，点击“确认并保存设置”后生效";
        }

        private void ConfigureGrid()
        {
            grid.AllowUserToAddRows = false; grid.RowHeadersVisible = false; grid.AutoGenerateColumns = false; grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect; grid.BackgroundColor = Color.White; grid.BorderStyle = BorderStyle.None; grid.EnableHeadersVisualStyles = false; grid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(232, 241, 248);
            grid.Columns.Add(new DataGridViewCheckBoxColumn { HeaderText = "自动化", Width = 70 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "TikTok 店铺", Width = 190, ReadOnly = true });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "站点", Width = 65, ReadOnly = true });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "系统店铺简称", Width = 220, ReadOnly = true });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "浏览器配置", Width = 180, ReadOnly = true });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "登录状态", Width = 130, ReadOnly = true });
        }

        private void LoadConfig()
        {
            config = json.Deserialize<Config>(File.ReadAllText(configPath, Encoding.UTF8));
            if (config == null) throw new Exception("店铺配置为空。");
            if (config.shopMappings == null) config.shopMappings = new List<Shop>();
            var rules = config.syncRules ?? new SyncRules();
            lookbackDays.Value = rules.orders >= 1 ? rules.orders : (config.exportLookbackDays >= 1 ? config.exportLookbackDays : 3);
            settledDays.Value = rules.settledBills >= 1 ? rules.settledBills : 1;
            unsettledDays.Value = rules.unsettledBills >= 1 ? rules.unsettledBills : 2;
            promotionDays.Value = rules.promotions >= 1 ? rules.promotions : 1;
            var settingsPath = Path.Combine(config.rootDir, "自动任务设置.json");
            if (File.Exists(settingsPath))
            {
                var settings = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsPath, Encoding.UTF8));
                object value;
                DateTime parsed;
                if (settings != null && settings.TryGetValue("time", out value) && DateTime.TryParseExact(Convert.ToString(value), "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out parsed)) runTime.Text = parsed.ToString("HH:mm");
            }
            grid.Rows.Clear();
            foreach (var shop in config.shopMappings)
            {
                var row = grid.Rows.Add(shop.automationEnabled, shop.sellerCenterName, shop.countryCode, shop.systemShopCode, shop.profileKey, LoginStatus(shop));
                grid.Rows[row].Tag = shop;
            }
            status.Text = "已启用 " + config.shopMappings.Count(s => s.automationEnabled) + " 家店铺";
            RefreshAuthorizationStatus();
        }

        private void RefreshShopLoginStatuses()
        {
            try
            {
                if (!File.Exists(configPath)) return;
                var latest = json.Deserialize<Config>(File.ReadAllText(configPath, Encoding.UTF8));
                if (latest == null || latest.shopMappings == null) return;
                foreach (DataGridViewRow row in grid.Rows)
                {
                    var shop = row.Tag as Shop;
                    if (shop == null) continue;
                    var saved = latest.shopMappings.FirstOrDefault(item => String.Equals(item.profileKey ?? "default", shop.profileKey ?? "default", StringComparison.OrdinalIgnoreCase));
                    if (saved == null) continue;
                    shop.verifiedAt = saved.verifiedAt;
                    row.Cells[5].Value = LoginStatus(shop);
                }
            }
            catch { /* 下一次刷新时重试，避免状态读取影响主界面。 */ }
        }

        private static string LoginStatus(Shop shop)
        {
            var credential = CredentialVault.HasCredentials(shop.profileKey) ? "账号已保存" : "未保存账号";
            return credential + " · " + (String.IsNullOrWhiteSpace(shop.verifiedAt) ? "待登录" : "已配置");
        }

        private void RefreshAuthorizationStatus()
        {
            if (config == null || String.IsNullOrWhiteSpace(config.rootDir)) return;
            var filePath = Path.Combine(config.rootDir, "待处理", "系统管理员授权状态.json");
            if (!File.Exists(filePath)) { authStatus.Text = "系统授权：未设置"; return; }
            try
            {
                var value = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(filePath, Encoding.UTF8));
                var state = value != null && value.ContainsKey("status") ? Convert.ToString(value["status"]) : "";
                var message = value != null && value.ContainsKey("message") ? Convert.ToString(value["message"]) : "";
                if (state == "ready") authStatus.Text = "系统授权：已保存，可自动导入";
                else if (state == "waiting_login") authStatus.Text = "系统授权：等待你在浏览器完成登录";
                else authStatus.Text = "系统授权：" + ShortStatus(String.IsNullOrWhiteSpace(message) ? "需要重新登录" : message);
            }
            catch { authStatus.Text = "系统授权：状态读取失败"; }
        }

        private static string ShortStatus(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return "";
            var compact = String.Join(" ", value.Split(new[] { '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries).Select(item => item.Trim()).Where(item => item.Length > 0));
            return compact.Length > 52 ? compact.Substring(0, 52) + "…" : compact;
        }

        private void RefreshRunStatus()
        {
            if (config == null || String.IsNullOrWhiteSpace(config.rootDir)) return;
            var filePath = Path.Combine(config.rootDir, "待处理", "同步助手状态.json");
            if (!File.Exists(filePath)) { runStatus.Text = "尚无执行记录。请先运行“运行前检测”或等待定时任务。"; return; }
            try
            {
                var value = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(filePath, Encoding.UTF8));
                var modeKey = value.ContainsKey("mode") ? Convert.ToString(value["mode"]) : "";
                var mode = modeKey == "preflight" ? "运行前检测" : (modeKey == "custom_range" ? "按日期范围同步" : "订单、账单与推广同步");
                var statusText = value.ContainsKey("status") ? Convert.ToString(value["status"]) : "未知";
                var completedAt = value.ContainsKey("completedAt") && value["completedAt"] != null ? Convert.ToString(value["completedAt"]) : "执行中";
                if (String.Equals(statusText, "running", StringComparison.OrdinalIgnoreCase) && !RunnerProcessAlive(value))
                {
                    statusText = "interrupted"; completedAt = "同步启动器已退出";
                }
                var message = value.ContainsKey("message") ? Convert.ToString(value["message"]) : "";
                var results = new List<string>();
                var stores = value.ContainsKey("stores") ? value["stores"] as IEnumerable : null;
                if (stores != null) foreach (var item in stores)
                {
                    var store = item as Dictionary<string, object>;
                    if (store == null) continue;
                    var name = store.ContainsKey("store") ? Convert.ToString(store["store"]) : "店铺";
                    var storeStatus = store.ContainsKey("status") ? Convert.ToString(store["status"]) : "等待";
                    var detail = store.ContainsKey("unsettledBillBatchCode") && store["unsettledBillBatchCode"] != null ? "订单 " + (store.ContainsKey("batchCode") && store["batchCode"] != null ? Convert.ToString(store["batchCode"]) : "无新增") + "；未结算 " + Convert.ToString(store["unsettledBillBatchCode"]) : (store.ContainsKey("batchCode") && store["batchCode"] != null ? "订单批次 " + Convert.ToString(store["batchCode"]) : (store.ContainsKey("error") && store["error"] != null ? Convert.ToString(store["error"]).Split('\n')[0] : ""));
                    var promotion = store.ContainsKey("promotion") ? store["promotion"] as Dictionary<string, object> : null;
                    if (promotion != null) detail += (String.IsNullOrWhiteSpace(detail) ? "" : "；") + "推广 " + (promotion.ContainsKey("batchCode") && promotion["batchCode"] != null ? Convert.ToString(promotion["batchCode"]) : (promotion.ContainsKey("status") ? Convert.ToString(promotion["status"]) : "等待"));
                    results.Add(name + "：" + storeStatus + (String.IsNullOrWhiteSpace(detail) ? "" : "（" + detail + "）"));
                }
                runStatus.Text = mode + " · " + statusText + " · " + completedAt + "\r\n" + message + (results.Count > 0 ? "\r\n" + String.Join("；", results) : "");
            }
            catch { runStatus.Text = "运行状态文件无法读取，请重新执行运行前检测。"; }
        }

        private static bool RunnerProcessAlive(Dictionary<string, object> value)
        {
            try
            {
                object raw; if (value == null || !value.TryGetValue("pid", out raw)) return false;
                var process = Process.GetProcessById(Convert.ToInt32(raw)); return !process.HasExited;
            }
            catch { return false; }
        }

        private void CancelCurrentRun(object sender, EventArgs eventArgs)
        {
            if (config == null || String.IsNullOrWhiteSpace(config.rootDir)) return;
            try
            {
                var pending = Path.Combine(config.rootDir, "待处理"); Directory.CreateDirectory(pending);
                File.WriteAllText(Path.Combine(pending, "同步助手取消请求.json"), json.Serialize(new { requestedAt = DateTime.UtcNow.ToString("o"), requestedBy = "desktop" }), Encoding.UTF8);
                var statePath = Path.Combine(pending, "同步助手状态.json");
                var state = File.Exists(statePath) ? json.Deserialize<Dictionary<string, object>>(File.ReadAllText(statePath, Encoding.UTF8)) : null;
                int pid = 0; object raw;
                if (state != null && state.TryGetValue("pid", out raw)) Int32.TryParse(Convert.ToString(raw), out pid);
                if (activeRunner != null && !activeRunner.HasExited) pid = activeRunner.Id;
                if (pid > 0) Process.Start(new ProcessStartInfo { FileName = "taskkill.exe", Arguments = "/PID " + pid + " /T /F", CreateNoWindow = true, UseShellExecute = false }).WaitForExit();
                if (state != null) { state["status"] = "cancelled"; state["completedAt"] = DateTime.UtcNow.ToString("o"); state["message"] = "已由用户停止当前同步任务。"; File.WriteAllText(statePath, json.Serialize(state), Encoding.UTF8); }
                activeRunner = null; RefreshRunStatus();
            }
            catch (Exception error) { MessageBox.Show(error.Message, "停止任务失败"); }
        }

        private void ShowLastRunResult(object sender, EventArgs eventArgs)
        {
            if (config == null || String.IsNullOrWhiteSpace(config.rootDir)) { MessageBox.Show("尚未加载同步配置。", "运行结果"); return; }
            var filePath = Path.Combine(config.rootDir, "待处理", "同步助手状态.json");
            if (!File.Exists(filePath)) { MessageBox.Show("暂无最近一次运行记录。", "运行结果"); return; }
            try
            {
                var value = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(filePath, Encoding.UTF8));
                var text = new StringBuilder();
                text.AppendLine("最近一次自动同步结果");
                text.AppendLine("日期：" + ResultValue(value, "targetDate", "—"));
                text.AppendLine("状态：" + ResultValue(value, "status", "未知"));
                text.AppendLine("开始：" + ResultValue(value, "startedAt", "—"));
                text.AppendLine("完成：" + ResultValue(value, "completedAt", "进行中"));
                text.AppendLine("汇总：" + ResultValue(value, "message", "—"));
                var stores = value.ContainsKey("stores") ? value["stores"] as IEnumerable : null;
                if (stores != null) foreach (var item in stores)
                {
                    var store = item as Dictionary<string, object>;
                    if (store == null) continue;
                    text.AppendLine();
                    text.AppendLine("【" + ResultValue(store, "store", "店铺") + " · " + ResultValue(store, "countryCode", "—") + "】 " + ResultValue(store, "status", "未知"));
                    AppendStageResult(text, store, "login", "自动登录");
                    AppendStageResult(text, store, "order", "订单");
                    AppendStageResult(text, store, "settledBill", "已结算账单");
                    AppendStageResult(text, store, "unsettledBill", "未结算账单");
                    AppendStageResult(text, store, "promotion", "推广");
                    AppendStageResult(text, store, "orders", "订单范围");
                    AppendStageResult(text, store, "settledBills", "已结算范围");
                    AppendStageResult(text, store, "unsettledBills", "未结算范围");
                    AppendStageResult(text, store, "promotions", "推广范围");
                    var error = ResultValue(store, "error", "");
                    if (!String.IsNullOrWhiteSpace(error)) text.AppendLine("  原因：" + error);
                }
                using (var dialog = new Form { Text = "最近一次运行结果", Size = new Size(760, 560), StartPosition = FormStartPosition.CenterParent, Font = new Font("Microsoft YaHei UI", 9), MinimizeBox = false, MaximizeBox = false })
                {
                    var content = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, WordWrap = true, Location = new Point(20, 20), Size = new Size(704, 440), BackColor = Color.FromArgb(248, 251, 253), Text = text.ToString() };
                    var close = new Button { Text = "关闭", DialogResult = DialogResult.OK, Location = new Point(632, 475), Size = new Size(92, 32) };
                    dialog.Controls.Add(content); dialog.Controls.Add(close); dialog.AcceptButton = close;
                    dialog.ShowDialog(this);
                }
            }
            catch (Exception error) { MessageBox.Show(error.Message, "无法读取运行结果", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }

        private static string ResultValue(Dictionary<string, object> values, string key, string fallback)
        {
            object value;
            return values != null && values.TryGetValue(key, out value) && value != null && !String.IsNullOrWhiteSpace(Convert.ToString(value)) ? Convert.ToString(value) : fallback;
        }

        private static void AppendStageResult(StringBuilder text, Dictionary<string, object> store, string key, string label)
        {
            object raw;
            var stage = store != null && store.TryGetValue(key, out raw) ? raw as Dictionary<string, object> : null;
            if (stage == null) return;
            var status = ResultValue(stage, "status", "未执行");
            var batch = ResultValue(stage, "batchCode", "");
            var error = ResultValue(stage, "error", "");
            var attempts = ResultValue(stage, "attempts", "1");
            var retried = String.Equals(ResultValue(stage, "retried", "false"), "true", StringComparison.OrdinalIgnoreCase);
            text.AppendLine("  " + label + "：" + status + (String.IsNullOrWhiteSpace(batch) ? "" : "（批次 " + batch + "）") + "；执行 " + attempts + " 次" + (retried ? "（首轮结束后已重试）" : "") + (String.IsNullOrWhiteSpace(error) ? "" : "；" + error));
        }

        private void SaveConfig()
        {
            var enabledKeys = new List<string>();
            foreach (DataGridViewRow row in grid.Rows)
            {
                var shop = row.Tag as Shop;
                if (shop != null && Convert.ToBoolean(row.Cells[0].Value)) enabledKeys.Add(shop.profileKey ?? "default");
            }
            var updater = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "automation-store-config.js");
            var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(json.Serialize(new { orders = Decimal.ToInt32(lookbackDays.Value), settledBills = Decimal.ToInt32(settledDays.Value), unsettledBills = Decimal.ToInt32(unsettledDays.Value), promotions = Decimal.ToInt32(promotionDays.Value), enabledKeys = enabledKeys })));
            var process = Process.Start(new ProcessStartInfo { FileName = @"C:\Program Files\nodejs\node.exe", Arguments = "\"" + updater + "\" save-rules " + payload, CreateNoWindow = true, UseShellExecute = false, RedirectStandardError = true });
            process.WaitForExit();
            if (process.ExitCode != 0) throw new Exception(process.StandardError.ReadToEnd());
            LoadConfig();
        }

        private void ConfirmSettings(object sender, EventArgs eventArgs)
        {
            try
            {
                DateTime parsedTime;
                if (!DateTime.TryParseExact(runTime.Text, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out parsedTime)) throw new Exception("每日运行时间请输入 HH:mm，例如 09:10。");
                SaveConfig();
                var script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "save-automation-schedule.ps1");
                var process = Process.Start(new ProcessStartInfo { FileName = "powershell.exe", Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Time " + parsedTime.ToString("HH:mm"), CreateNoWindow = true, UseShellExecute = false, RedirectStandardError = true });
                process.WaitForExit();
                if (process.ExitCode != 0) throw new Exception(process.StandardError.ReadToEnd());
                MessageBox.Show("当前设置已确认：每天只会启动一个串行任务，按勾选顺序使用已保存的店铺登录状态，依次同步 UTC 前一日订单、已结算账单、未结算账单与推广日报。账单失败不会中断后续任务，首轮全部完成后会自动重试失败账单一次。", "自动同步助手");
            }
            catch (Exception error) { MessageBox.Show(error.Message, "保存失败"); }
        }

        private void AddShop(object sender, EventArgs eventArgs)
        {
            try
            {
                status.Text = "正在打开添加店铺窗口…";
                using (var dialog = new AddShopForm())
                {
                    // 独立窗口在远程桌面或多屏场景也必须显示在当前助手前方，避免看起来像“点击无响应”。
                    dialog.StartPosition = FormStartPosition.CenterScreen;
                    dialog.ShowInTaskbar = false;
                    dialog.TopMost = true;
                    dialog.Shown += delegate { dialog.Activate(); dialog.BringToFront(); };
                    if (dialog.ShowDialog(this) != DialogResult.OK) { status.Text = "已取消添加店铺"; return; }
                    if (config.shopMappings.Any(s => s.sellerCenterName == dialog.SellerName && String.Equals(s.countryCode, dialog.CountryCode, StringComparison.OrdinalIgnoreCase)))
                    { MessageBox.Show("该 TikTok 店铺和站点已存在。", "无法添加"); return; }
                    // 新店铺必须先落盘；仅修改内存对象后再保存同步规则，会被 LoadConfig 覆盖而消失。
                    var updater = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "automation-store-config.js");
                    var arguments = "\"" + updater + "\" add " + CommandArg(dialog.SellerName) + " " + CommandArg(dialog.CountryCode) + " " + CommandArg(dialog.SystemShopCode);
                    var process = Process.Start(new ProcessStartInfo { FileName = @"C:\Program Files\nodejs\node.exe", Arguments = arguments, CreateNoWindow = true, UseShellExecute = false, RedirectStandardError = true });
                    process.WaitForExit();
                    if (process.ExitCode != 0) throw new Exception(process.StandardError.ReadToEnd());
                    LoadConfig();
                    // add 操作已经保留了所有店铺的自动化状态；这里不能再次调用 SaveConfig，
                    // 否则 DataGridView 的临时勾选状态可能会覆盖刚写入的配置。
                    status.Text = "店铺已添加并默认启用自动化，请选择后点击“打开登录”完成该店铺登录";
                    MessageBox.Show("店铺已添加并默认启用自动化。请选择后点击“打开登录”完成该店铺登录。", "添加成功");
                }
            }
            catch (Exception error) { status.Text = "添加店铺失败"; MessageBox.Show(error.Message, "无法打开添加店铺窗口", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }

        private string MakeProfileKey(string value)
        {
            var chars = value.Select(c => Char.IsLetterOrDigit(c) || c == '_' || c == '-' ? Char.ToLowerInvariant(c) : '-').ToArray();
            var key = new string(chars).Trim('-'); if (String.IsNullOrWhiteSpace(key)) key = "shop";
            var baseKey = key; var i = 2; while (config.shopMappings.Any(s => s.profileKey == key)) key = baseKey + "-" + i++;
            return key;
        }

        private static string CommandArg(string value)
        {
            return "\"" + (value ?? "").Replace("\"", "\\\"") + "\"";
        }

        private Shop SelectedShop() { return grid.CurrentRow == null ? null : grid.CurrentRow.Tag as Shop; }
        private void OpenLogin(object sender, EventArgs eventArgs)
        {
            var shop = SelectedShop(); if (shop == null) { MessageBox.Show("请先选择店铺。"); return; }
            var profile = shop.profileKey == "default" ? Path.Combine(config.rootDir, "浏览器配置", "TikTokShop下载助手") : Path.Combine(config.rootDir, "浏览器配置", "TikTokShop下载助手-" + shop.profileKey);
            Directory.CreateDirectory(profile);
            var chrome = File.Exists(@"C:\Program Files\Google\Chrome\Application\chrome.exe") ? @"C:\Program Files\Google\Chrome\Application\chrome.exe" : @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe";
            Process.Start(chrome, "--user-data-dir=\"" + profile + "\" " + (config.sellerCenterUrl ?? "https://seller.tiktokshopglobalselling.com/"));
            if (grid.CurrentRow != null) grid.CurrentRow.Cells[5].Value = "登录后请运行前检测";
        }

        private void AuthorizeSystem(object sender, EventArgs eventArgs)
        {
            var shop = SelectedShop(); if (shop == null) { MessageBox.Show("请先选择一个店铺。", "系统授权"); return; }
            var notice = "将打开独立的“系统授权”Chrome 浏览器，不会影响已登录的 TikTok 店铺。\n\n请在新窗口完成系统管理员登录，并勾选“记住登录状态”和“记住密码”；看到“已保存，可自动导入”后可以关闭浏览器。\n\n账号、密码及登录授权只会使用当前 Windows 用户的加密保护保存，30 天内令牌失效时助手会自动重新登录，不会写入配置文件或运行日志。";
            if (MessageBox.Show(notice, "系统授权登录", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return;
            try
            {
                var script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "capture-system-auth.js");
                Process.Start(new ProcessStartInfo { FileName = @"C:\Program Files\nodejs\node.exe", Arguments = "\"" + script + "\" --store \"" + shop.profileKey + "\"", CreateNoWindow = true, UseShellExecute = false });
                authStatus.Text = "系统授权：正在打开登录页面…";
            }
            catch (Exception error) { MessageBox.Show(error.Message, "无法启动系统授权"); }
        }

        private void ManageAccounts(object sender, EventArgs eventArgs)
        {
            if (config == null || config.shopMappings == null || !config.shopMappings.Any()) { MessageBox.Show("请先添加店铺。", "账号管理"); return; }
            using (var dialog = new AccountManagementForm(config.shopMappings)) dialog.ShowDialog(this);
            RefreshShopLoginStatuses();
        }

        private void DeleteShop(object sender, EventArgs eventArgs)
        {
            var shop = SelectedShop(); if (shop == null) return;
            if (MessageBox.Show("删除所选店铺配置？", "确认", MessageBoxButtons.YesNo) != DialogResult.Yes) return;
            config.shopMappings.Remove(shop); SaveConfig();
        }

        private void DryRun(object sender, EventArgs eventArgs)
        {
            var shop = SelectedShop(); if (shop == null) { MessageBox.Show("请先选择店铺。"); return; }
            Process.Start(new ProcessStartInfo { FileName = @"C:\Program Files\nodejs\node.exe", Arguments = "\"" + Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tiktok-daily-job.js") + "\" --store \"" + shop.profileKey + "\" --dry-run", CreateNoWindow = true, UseShellExecute = false });
            MessageBox.Show("演练已启动，不会下载或导入。", "自动同步助手");
        }

        private void StartRunner(bool checkOnly)
        {
            try
            {
                SaveConfig();
                var runner = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tiktok-sync-runner.js");
                var arguments = "\"" + runner + "\"" + (checkOnly ? " --check" : "");
                var cancelPath = Path.Combine(config.rootDir, "待处理", "同步助手取消请求.json"); if (File.Exists(cancelPath)) File.Delete(cancelPath);
                activeRunner = Process.Start(new ProcessStartInfo { FileName = @"C:\Program Files\nodejs\node.exe", Arguments = arguments, CreateNoWindow = true, UseShellExecute = false });
                runStatus.Text = checkOnly ? "正在逐店检查登录、店铺映射、系统授权、已结算和未结算账单入口…" : "正在逐店自动登录并串行同步前一日订单、已结算与未结算账单…";
            }
            catch (Exception error) { MessageBox.Show(error.Message, "无法启动自动任务"); }
        }

        private void RunPreflight(object sender, EventArgs eventArgs) { StartRunner(true); }
        private void RunDateRange(object sender, EventArgs eventArgs)
        {
            try
            {
                // The grid selection is the source of truth for every launch.
                // Persist it before showing the range dialog so a newly chosen
                // store is never replaced by a previous enabled store.
                SaveConfig();
                using (var dialog = new DateRangeSyncForm())
                {
                    if (dialog.ShowDialog(this) != DialogResult.OK) return;
                    var runner = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tiktok-range-sync-runner.js");
                    if (!File.Exists(runner)) throw new Exception("未找到日期范围同步脚本：" + runner);
                    var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(json.Serialize(dialog.Ranges)));
                    var cancelPath = Path.Combine(config.rootDir, "待处理", "同步助手取消请求.json"); if (File.Exists(cancelPath)) File.Delete(cancelPath);
                    activeRunner = Process.Start(new ProcessStartInfo { FileName = @"C:\Program Files\nodejs\node.exe", Arguments = "\"" + runner + "\" --ranges " + payload, CreateNoWindow = true, UseShellExecute = false });
                    if (activeRunner == null) throw new Exception("日期范围同步进程未能启动。");
                    runStatus.Text = "正在按自定义日期范围逐店串行同步…";
                }
            }
            catch (Exception error) { MessageBox.Show(error.Message, "无法启动范围同步", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
        private void RunNow(object sender, EventArgs eventArgs)
        {
            if (MessageBox.Show("将按顺序启动各店铺专用浏览器配置，自动下载前一日订单、已结算账单和未结算账单。任一账单失败会先跳过并继续后续任务，首轮结束后自动重试失败账单一次。只有登录、店铺映射及文件校验均通过时才会写入系统，并在成功后归档源文件，是否继续？", "立即串行同步", MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes) StartRunner(false);
        }

    }

    public class DateRangeSyncForm : Form
    {
        private readonly Dictionary<string, CheckBox> enabled = new Dictionary<string, CheckBox>();
        private readonly Dictionary<string, DateTimePicker> starts = new Dictionary<string, DateTimePicker>();
        private readonly Dictionary<string, DateTimePicker> ends = new Dictionary<string, DateTimePicker>();
        public Dictionary<string, object> Ranges { get; private set; }
        public DateRangeSyncForm()
        {
            Text = "按日期范围同步"; Size = new Size(610, 350); StartPosition = FormStartPosition.CenterParent; Font = new Font("Microsoft YaHei UI", 9); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
            Controls.Add(new Label { Text = "按数据类型选择任意起止日期", Font = new Font("Microsoft YaHei UI", 11, FontStyle.Bold), Location = new Point(22, 18), AutoSize = true });
            Controls.Add(new Label { Text = "每种数据会按所选起止日期一次导出；保存文件名显示“开始日期至结束日期”。", ForeColor = Color.FromArgb(80, 105, 130), Location = new Point(22, 48), AutoSize = true });
            Controls.Add(new Label { Text = "数据类型", Location = new Point(42, 82), AutoSize = true });
            Controls.Add(new Label { Text = "开始日期", Location = new Point(238, 82), AutoSize = true });
            Controls.Add(new Label { Text = "结束日期", Location = new Point(398, 82), AutoSize = true });
            AddRange("orders", "订单", 110); AddRange("settledBills", "已结算", 145); AddRange("unsettledBills", "未结算", 180); AddRange("promotions", "推广", 215);
            var confirm = new Button { Text = "开始范围同步", Location = new Point(368, 262), Size = new Size(115, 32), BackColor = Color.FromArgb(27, 157, 190), ForeColor = Color.White, FlatStyle = FlatStyle.Flat }; confirm.FlatAppearance.BorderSize = 0; confirm.Click += Confirm; Controls.Add(confirm);
            var cancel = new Button { Text = "取消", Location = new Point(493, 262), Size = new Size(82, 32) }; cancel.Click += delegate { Close(); }; Controls.Add(cancel);
        }
        private void AddRange(string key, string label, int y)
        {
            var check = new CheckBox { Text = label, Location = new Point(42, y), AutoSize = true, Checked = key == "orders" };
            var start = new DateTimePicker { Location = new Point(218, y - 4), Size = new Size(145, 27), Format = DateTimePickerFormat.Short, Value = DateTime.Today.AddDays(-1) };
            var end = new DateTimePicker { Location = new Point(378, y - 4), Size = new Size(145, 27), Format = DateTimePickerFormat.Short, Value = DateTime.Today.AddDays(-1) };
            enabled[key] = check; starts[key] = start; ends[key] = end; Controls.Add(check); Controls.Add(start); Controls.Add(end);
        }
        private void Confirm(object sender, EventArgs eventArgs)
        {
            var output = new Dictionary<string, object>();
            foreach (var key in enabled.Keys) if (enabled[key].Checked)
            {
                var start = starts[key].Value.Date; var end = ends[key].Value.Date;
                if (start > end) { MessageBox.Show("开始日期不能晚于结束日期。", "日期范围"); return; }
                if ((end - start).TotalDays > 365) { MessageBox.Show("单个日期范围最多 366 天。", "日期范围"); return; }
                output[key] = new { start = start.ToString("yyyy-MM-dd"), end = end.ToString("yyyy-MM-dd") };
            }
            if (!output.Any()) { MessageBox.Show("请至少选择一种数据类型。", "日期范围"); return; }
            Ranges = output; DialogResult = DialogResult.OK; Close();
        }
    }

    public class AccountManagementForm : Form
    {
        private readonly List<Shop> shops;
        private readonly ListBox shopList = new ListBox();
        private readonly TextBox account = new TextBox();
        private readonly TextBox password = new TextBox { UseSystemPasswordChar = true };
        private readonly Label status = new Label();

        public AccountManagementForm(IEnumerable<Shop> source)
        {
            shops = source.ToList();
            Text = "账号管理"; Size = new Size(620, 385); StartPosition = FormStartPosition.CenterParent; Font = new Font("Microsoft YaHei UI", 9); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
            Controls.Add(new Label { Text = "为每家 TikTok 店铺保存登录账号和密码", Font = new Font("Microsoft YaHei UI", 11, FontStyle.Bold), Location = new Point(22, 20), AutoSize = true });
            Controls.Add(new Label { Text = "密码只会使用当前 Windows 用户的加密保护保存在本机，不会写入店铺配置、日志或上传到系统。", ForeColor = Color.FromArgb(80, 105, 130), Location = new Point(22, 52), AutoSize = true });
            shopList.Location = new Point(22, 86); shopList.Size = new Size(205, 210); shopList.DisplayMember = "sellerCenterName";
            foreach (var shop in shops) shopList.Items.Add(shop);
            shopList.SelectedIndexChanged += delegate { LoadSelected(); }; Controls.Add(shopList);
            Controls.Add(new Label { Text = "登录邮箱", Location = new Point(255, 92), AutoSize = true });
            account.Location = new Point(255, 118); account.Size = new Size(320, 27); Controls.Add(account);
            Controls.Add(new Label { Text = "登录密码", Location = new Point(255, 162), AutoSize = true });
            password.Location = new Point(255, 188); password.Size = new Size(320, 27); Controls.Add(password);
            status.Location = new Point(255, 225); status.Size = new Size(320, 42); status.ForeColor = Color.FromArgb(70, 101, 125); Controls.Add(status);
            var save = new Button { Text = "保存账号", Location = new Point(355, 292), Size = new Size(105, 34), BackColor = Color.FromArgb(27, 157, 190), ForeColor = Color.White, FlatStyle = FlatStyle.Flat }; save.FlatAppearance.BorderSize = 0; save.Click += SaveSelected; Controls.Add(save);
            var remove = new Button { Text = "清除账号", Location = new Point(470, 292), Size = new Size(105, 34), FlatStyle = FlatStyle.Flat }; remove.Click += RemoveSelected; Controls.Add(remove);
            if (shopList.Items.Count > 0) shopList.SelectedIndex = 0;
        }

        private Shop Selected { get { return shopList.SelectedItem as Shop; } }
        private void LoadSelected()
        {
            var shop = Selected; if (shop == null) return;
            account.Text = CredentialVault.Username(shop.profileKey);
            password.Text = "";
            status.Text = CredentialVault.HasCredentials(shop.profileKey)
                ? "已保存邮箱。同步时会自动切换到邮箱登录并填充。"
                : "尚未保存登录邮箱。首次请填写后保存。";
        }
        private void SaveSelected(object sender, EventArgs eventArgs)
        {
            var shop = Selected; if (shop == null) return;
            if (String.IsNullOrWhiteSpace(account.Text) || !account.Text.Contains("@")) { MessageBox.Show("请输入有效的登录邮箱。", "账号管理"); return; }
            if (String.IsNullOrWhiteSpace(password.Text)) { MessageBox.Show("为保护密码安全，更新账号时请同时输入密码。", "账号管理"); return; }
            try { CredentialVault.Set(shop.profileKey, account.Text, password.Text); password.Text = ""; status.Text = "账号已加密保存，将在同步登录失效时自动使用。"; }
            catch (Exception error) { MessageBox.Show(error.Message, "账号保存失败", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
        private void RemoveSelected(object sender, EventArgs eventArgs)
        {
            var shop = Selected; if (shop == null) return;
            if (MessageBox.Show("清除该店铺的本机登录账号和密码？此操作不会影响浏览器中已登录的会话。", "清除账号", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            CredentialVault.Remove(shop.profileKey); LoadSelected();
        }
    }

    public class AddShopForm : Form
    {
        private readonly TextBox seller = Field("TikTok 后台店铺名称", 24);
        private readonly TextBox country = Field("站点代码", 96);
        private readonly TextBox system = Field("系统“店铺管理”里的店铺简称", 168);
        public string SellerName { get { return seller.Text.Trim(); } }
        public string CountryCode { get { return country.Text.Trim().ToUpperInvariant(); } }
        public string SystemShopCode { get { return system.Text.Trim(); } }
        public AddShopForm()
        {
            Text = "添加店铺"; Size = new Size(465, 360); StartPosition = FormStartPosition.CenterParent; Font = new Font("Microsoft YaHei UI", 9); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
            Controls.AddRange(new Control[] { seller, country, system });
            var ok = new Button { Text = "添加并保存", Location = new Point(230, 255), Size = new Size(92, 34) }; ok.Click += delegate { if (String.IsNullOrWhiteSpace(SellerName) || String.IsNullOrWhiteSpace(CountryCode) || String.IsNullOrWhiteSpace(SystemShopCode)) { MessageBox.Show("请填写全部三项信息。"); return; } DialogResult = DialogResult.OK; Close(); }; Controls.Add(ok);
            var cancel = new Button { Text = "取消", Location = new Point(335, 255), Size = new Size(85, 34) }; cancel.Click += delegate { Close(); }; Controls.Add(cancel);
        }
        private static TextBox Field(string label, int y)
        {
            // Labels are added by the constructor after each textbox is created.
            return new TextBox { Location = new Point(25, y + 24), Size = new Size(395, 27), Tag = label };
        }
        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e); foreach (var input in Controls.OfType<TextBox>().ToArray()) Controls.Add(new Label { Text = (string)input.Tag, Location = new Point(25, input.Top - 24), AutoSize = true });
        }
    }
}
