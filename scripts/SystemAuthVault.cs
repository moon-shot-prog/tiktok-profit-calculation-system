using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

internal static class SystemAuthVault
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2) throw new ArgumentException("Usage: SystemAuthVault.exe save|read rootDir");
            var action = args[0].ToLowerInvariant();
            var rootDir = args[1];
            var vaultPath = Path.Combine(rootDir, "待处理", "系统管理员授权.dat");
            if (action == "save")
            {
                var encoded = Console.In.ReadToEnd().Trim();
                var json = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
                if (!json.Contains("\"accessToken\"") || !json.Contains("\"refreshToken\"")) throw new InvalidOperationException("Incomplete session.");
                var protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(json), null, DataProtectionScope.CurrentUser);
                Directory.CreateDirectory(Path.GetDirectoryName(vaultPath));
                File.WriteAllBytes(vaultPath, protectedBytes);
                Console.Out.Write("saved");
                return 0;
            }
            if (action == "read")
            {
                if (!File.Exists(vaultPath)) throw new FileNotFoundException("No saved system authorization.");
                var plain = ProtectedData.Unprotect(File.ReadAllBytes(vaultPath), null, DataProtectionScope.CurrentUser);
                Console.Out.Write(Convert.ToBase64String(plain));
                return 0;
            }
            throw new ArgumentException("Unknown action.");
        }
        catch (Exception)
        {
            return 1;
        }
    }
}
