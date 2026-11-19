using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

// Console-only bridge. The assistant UI remains a windowed application while
// Node can request a credential for the current Windows user without any
// plaintext credential file being created.
public class BridgeCredential { public string username { get; set; } public string passwordProtected { get; set; } public string updatedAt { get; set; } }
public class BridgeStore { public Dictionary<string, BridgeCredential> shops { get; set; } }
public static class TikTokCredentialBridge
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly string StorePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TikTokProfitSyncAssistant", "seller-credentials.json");
    private static byte[] Entropy(string key) { return Encoding.UTF8.GetBytes("TikTokSyncAssistant/" + (key ?? "default")); }
    public static int Main(string[] args)
    {
        try
        {
            if (args == null || args.Length != 2 || !String.Equals(args[0], "--credentials", StringComparison.OrdinalIgnoreCase)) throw new Exception("凭据参数无效");
            var key = args[1] ?? "default";
            var store = File.Exists(StorePath) ? Json.Deserialize<BridgeStore>(File.ReadAllText(StorePath, Encoding.UTF8)) : new BridgeStore { shops = new Dictionary<string, BridgeCredential>(StringComparer.OrdinalIgnoreCase) };
            BridgeCredential value;
            if (store == null || store.shops == null || !store.shops.TryGetValue(key, out value) || value == null || String.IsNullOrWhiteSpace(value.username) || String.IsNullOrWhiteSpace(value.passwordProtected))
            {
                Console.Write(Json.Serialize(new { configured = false }));
                return 0;
            }
            var password = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(value.passwordProtected), Entropy(key), DataProtectionScope.CurrentUser));
            Console.Write(Json.Serialize(new { configured = true, username = value.username, password = password }));
            return 0;
        }
        catch (Exception error) { Console.Error.Write(error.Message); return 1; }
    }
}
