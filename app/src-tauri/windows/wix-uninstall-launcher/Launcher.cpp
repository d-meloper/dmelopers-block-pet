// Private installed entry point. Burn owns all removal and data choices.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <msi.h>
#include <shlobj.h>
#include <shellapi.h>
#include <cstring>
#include <string>
#include <vector>

namespace {
constexpr wchar_t kProduct[] = L"DMeloper's Block Pet";
#if defined(BP_OFFICIAL_BUILD)
constexpr wchar_t kRegistry[] = L"Software\\DMeloper\\BlockPet\\Github";
constexpr wchar_t kBundleUpgrade[] = L"{8AD6D51E-F120-55B8-90C3-C15CD80E8173}";
constexpr wchar_t kMsiUpgrade[] = L"{70B77E49-EDA1-59D4-AFAB-7805E2FEA6A7}";
constexpr wchar_t kDeliveryMode[] = L"block-pet-wix-v1";
#else
constexpr wchar_t kRegistry[] = L"Software\\DMeloper\\BlockPet\\WixLocal";

constexpr wchar_t kBundleUpgrade[] = L"{7239299E-8103-5BC6-93F7-93D036A22F71}";
constexpr wchar_t kMsiUpgrade[] = L"{7D693AC9-0739-5A22-9237-A3506BCDE81E}";
constexpr wchar_t kDeliveryMode[] = L"block-pet-wix-local-v1";
#endif
constexpr wchar_t kArp[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

struct File {
    HANDLE handle = INVALID_HANDLE_VALUE;
    ~File() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
};
std::wstring Full(const std::wstring& path) {
    if (path.size() < 3 || path[1] != L':' || path[2] != L'\\' || path.find(L'"') != std::wstring::npos) return {};
    std::vector<wchar_t> buffer(32768);
    DWORD length = GetFullPathNameW(path.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
    if (!length || length >= buffer.size()) return {};
    std::wstring result(buffer.data(), length);
    while (result.size() > 3 && result.back() == L'\\') result.pop_back();
    return result;
}
bool Same(const std::wstring& a, const std::wstring& b) {
    auto x = Full(a), y = Full(b);
    return !x.empty() && !y.empty() && _wcsicmp(x.c_str(), y.c_str()) == 0;
}
std::wstring Parent(const std::wstring& path) {
    auto index = path.find_last_of(L'\\');
    return index == std::wstring::npos ? std::wstring() : path.substr(0, index);
}
std::wstring Final(HANDLE file) {
    std::vector<wchar_t> buffer(32768);
    DWORD length = GetFinalPathNameByHandleW(file, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (!length || length >= buffer.size()) return {};
    std::wstring result(buffer.data(), length);
    if (result.compare(0, 4, L"\\\\?\\") == 0) result.erase(0, 4);
    return Full(result);
}
bool LockFile(const std::wstring& path, File& file) {
    std::wstring current = Full(path);
    if (current.empty()) return false;
    for (auto part = current; part.size() > 3; part = Parent(part)) {
        DWORD attributes = GetFileAttributesW(part.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    }
    file.handle = CreateFileW(current.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    return file.handle != INVALID_HANDLE_VALUE && Same(current, Final(file.handle));
}
std::vector<wchar_t> ReadValue(const std::wstring& key, const wchar_t* name, DWORD type) {
    DWORD size = 0;
    DWORD flags = type | RRF_SUBKEY_WOW6464KEY;
    if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), name, flags, nullptr, nullptr, &size) != ERROR_SUCCESS || size < 2 || size > 65536 || size % 2) return {};
    std::vector<wchar_t> result(size / 2 + 2, 0);
    if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), name, flags, nullptr, result.data(), &size) != ERROR_SUCCESS) return {};
    return result;
}
std::wstring String(const std::wstring& key, const wchar_t* name) {
    auto value = ReadValue(key, name, RRF_RT_REG_SZ);
    return value.empty() ? std::wstring() : std::wstring(value.data());
}
DWORD Number(const std::wstring& key, const wchar_t* name) {
    DWORD value = MAXDWORD, size = sizeof(value);
    return RegGetValueW(HKEY_CURRENT_USER, key.c_str(), name, RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &value, &size) == ERROR_SUCCESS ? value : MAXDWORD;
}
bool Upgrade(const std::wstring& key) {
    auto values = ReadValue(key, L"BundleUpgradeCode", RRF_RT_REG_MULTI_SZ);
    for (size_t offset = 0; offset < values.size() && values[offset];) {
        size_t end = offset;
        while (end < values.size() && values[end]) ++end;
        if (end == values.size()) return false;
        if (_wcsicmp(std::wstring(values.data() + offset, end - offset).c_str(), kBundleUpgrade) == 0) return true;
        offset = end + 1;
    }
    return false;
}
bool Guid(const std::wstring& value) {
    if (value.size() != 38 || value.front() != L'{' || value.back() != L'}') return false;
    for (size_t i = 1; i < 37; ++i) {
        wchar_t c = value[i];
        if (i == 9 || i == 14 || i == 19 || i == 24) { if (c != L'-') return false; }
        else if (!(c >= L'0' && c <= L'9') && !(c >= L'A' && c <= L'F') && !(c >= L'a' && c <= L'f')) return false;
    }
    return true;
}
bool Version(const std::wstring& value) {
    if (value.empty() || value.size() > 17) return false;
    unsigned parts = 0;
    size_t offset = 0;
    while (offset < value.size()) {
        size_t start = offset;
        unsigned number = 0;
        while (offset < value.size() && value[offset] >= L'0' && value[offset] <= L'9') {
            number = number * 10 + static_cast<unsigned>(value[offset++] - L'0');
            if (number > 65535) return false;
        }
        if (offset == start || (offset - start > 1 && value[start] == L'0')) return false;
        ++parts;
        if (offset == value.size()) break;
        if (value[offset++] != L'.' || offset == value.size()) return false;
    }
    return parts == 3;
}
std::wstring Msi(const std::wstring& product, const wchar_t* name) {
    std::vector<wchar_t> value(32768); DWORD size = static_cast<DWORD>(value.size());
    return MsiGetProductInfoExW(product.c_str(), nullptr, MSIINSTALLCONTEXT_USERUNMANAGED, name, value.data(), &size) == ERROR_SUCCESS ? std::wstring(value.data(), size) : std::wstring();
}
std::wstring LocalAppData() {
    PWSTR path = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &path))) return {};
    std::wstring result(path); CoTaskMemFree(path); return Full(result);
}
std::wstring CachePath(const std::wstring& local, const std::wstring& code, const std::wstring& version) {
    if (Full(local).empty() || !Guid(code) || !Version(version)) return {};
    return Full(local) + L"\\Package Cache\\" + code + L"\\dmelopers-block-pet_" + version + L"_x64-setup.exe";
}
bool FileProduct(const std::wstring& path, const std::wstring& version) {
    DWORD unused = 0, size = GetFileVersionInfoSizeW(path.c_str(), &unused);
    if (!size || size > 1024 * 1024) return false;
    std::vector<BYTE> info(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, info.data())) return false;
    struct Translation { WORD language, codepage; };
    Translation* translations = nullptr; UINT bytes = 0;
    if (!VerQueryValueW(info.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&translations), &bytes) || bytes < sizeof(Translation)) return false;
    auto text = [&](const wchar_t* field) {
        wchar_t key[128]{}; swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\%s", translations[0].language, translations[0].codepage, field);
        wchar_t* value = nullptr; UINT length = 0;
        return VerQueryValueW(info.data(), key, reinterpret_cast<void**>(&value), &length) && value && length ? std::wstring(value) : std::wstring();
    };
    std::wstring embedded = text(L"ProductVersion");
    return text(L"ProductName") == kProduct && text(L"CompanyName") == L"DMeloper" && (embedded == version || embedded == version + L".0");
}
bool BundleBytes(const std::vector<BYTE>& bytes, const std::wstring& code) {
    GUID expected{};
    if (!Guid(code) || FAILED(CLSIDFromString(code.c_str(), &expected)) || bytes.size() < sizeof(IMAGE_DOS_HEADER)) return false;
    IMAGE_DOS_HEADER dos{}; memcpy(&dos, bytes.data(), sizeof(dos));
    if (dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew < 0) return false;
    size_t nt = static_cast<size_t>(dos.e_lfanew);
    if (nt > bytes.size() || bytes.size() - nt < sizeof(DWORD) + sizeof(IMAGE_FILE_HEADER)) return false;
    DWORD signature = 0; IMAGE_FILE_HEADER header{};
    memcpy(&signature, bytes.data() + nt, sizeof(signature));
    memcpy(&header, bytes.data() + nt + sizeof(signature), sizeof(header));
    if (signature != IMAGE_NT_SIGNATURE || !header.NumberOfSections || header.NumberOfSections > 96 || header.SizeOfOptionalHeader < 96) return false;
    size_t table = nt + sizeof(signature) + sizeof(header) + header.SizeOfOptionalHeader;
    if (table > bytes.size() || (bytes.size() - table) / sizeof(IMAGE_SECTION_HEADER) < header.NumberOfSections) return false;
    for (unsigned i = 0; i < header.NumberOfSections; ++i) {
        IMAGE_SECTION_HEADER section{}; memcpy(&section, bytes.data() + table + i * sizeof(section), sizeof(section));
        if (memcmp(section.Name, ".wixburn", 8)) continue;
        size_t offset = section.PointerToRawData;
        if (section.SizeOfRawData < 24 || offset > bytes.size() || bytes.size() - offset < section.SizeOfRawData) return false;
        DWORD magic = 0, format = 0; GUID actual{};
        // WiX 7 section.cpp: two DWORDs precede its bundle GUID. Pinned format 2.
        memcpy(&magic, bytes.data() + offset, 4); memcpy(&format, bytes.data() + offset + 4, 4);
        memcpy(&actual, bytes.data() + offset + 8, sizeof(actual));
        return magic == 0x00F14300 && format == 2 && IsEqualGUID(expected, actual);
    }
    return false;
}
bool BundleFile(HANDLE file, const std::wstring& code) {
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size) || size.QuadPart < 24 || size.QuadPart > 32 * 1024 * 1024) return false;
    std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart)); DWORD read = 0;
    LARGE_INTEGER start{};
    return SetFilePointerEx(file, start, nullptr, FILE_BEGIN) && ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) && read == bytes.size() && BundleBytes(bytes, code);
}
std::wstring RegisteredCache(const std::wstring& version, const std::wstring& local) {
    HKEY root = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kArp, 0, KEY_READ | KEY_WOW64_64KEY, &root) != ERROR_SUCCESS) return {};
    std::wstring found; unsigned matches = 0;
    for (DWORD index = 0;; ++index) {
        wchar_t name[256]{}; DWORD length = 256;
        LONG status = RegEnumKeyExW(root, index, name, &length, nullptr, nullptr, nullptr, nullptr);
        if (status == ERROR_NO_MORE_ITEMS) break;
        if (status != ERROR_SUCCESS) { matches = 2; break; }
        std::wstring code(name, length), key = std::wstring(kArp) + L"\\" + code;
        if (String(key, L"DisplayName") != kProduct || !Upgrade(key)) continue;
        // Multiple matching registrations are ambiguous, even if one is damaged.
        ++matches;
        std::wstring expected = CachePath(local, code, version);
        if (String(key, L"Publisher") != L"DMeloper" || String(key, L"DisplayVersion") != version ||
            Number(key, L"Installed") != 1 || Number(key, L"BundleScope") != 2 ||
            _wcsicmp(String(key, L"BundleProviderKey").c_str(), code.c_str()) != 0 ||
            !Same(String(key, L"BundleCachePath"), expected)) continue;
        found = expected;
    }
    RegCloseKey(root);
    return matches == 1 ? found : std::wstring();
}
std::wstring Command(const std::wstring& path) { return L"\"" + path + L"\" /uninstall"; }
bool SelfTest() {
    std::wstring guid = L"{8C62790B-5FE7-4787-B501-6AF0F6FF8236}";
    if (!Guid(guid) || Guid(L"{8C62790B-5FE7-4787-B501-6AF0F6FF8236} /quiet")) return false;
    for (const wchar_t* invalid : { L"1", L"1.0", L"1.0.0.0", L"1.0.0 /quiet", L"01.0.0", L"1.0.", L"1.0.65536", L"../1.0.0" }) if (Version(invalid)) return false;
    if (!Version(L"1.0.0") || !Version(L"1.0.1")) return false;
    std::wstring local = L"C:\\Users\\Unicode 😶安★\\AppData\\Local";
    auto expected = local + L"\\Package Cache\\" + guid + L"\\dmelopers-block-pet_1.0.0_x64-setup.exe";
    if (CachePath(local, guid, L"1.0.0") != expected || CachePath(local, guid, L"1.0.0 /quiet") != L"" || Command(expected) != L"\"" + expected + L"\" /uninstall") return false;
    if (!Same(L"C:\\Unicode\\Folder\\", L"c:\\Unicode\\Folder") || Same(L"C:\\A", L"C:\\AB") || !Full(L"relative.exe").empty() || !Full(L"\\\\host\\file.exe").empty() || !Full(L"C:\\x\" /quiet").empty()) return false;
    std::vector<BYTE> pe(1024, 0); IMAGE_DOS_HEADER dos{}; dos.e_magic = IMAGE_DOS_SIGNATURE; dos.e_lfanew = 64;
    memcpy(pe.data(), &dos, sizeof(dos)); DWORD signature = IMAGE_NT_SIGNATURE; memcpy(pe.data() + 64, &signature, 4);
    IMAGE_FILE_HEADER header{}; header.NumberOfSections = 1; header.SizeOfOptionalHeader = 96;
    memcpy(pe.data() + 68, &header, sizeof(header)); IMAGE_SECTION_HEADER section{};
    memcpy(section.Name, ".wixburn", 8); section.PointerToRawData = 512; section.SizeOfRawData = 24;
    memcpy(pe.data() + 184, &section, sizeof(section)); DWORD magic = 0x00F14300, format = 2;
    memcpy(pe.data() + 512, &magic, 4); memcpy(pe.data() + 516, &format, 4);
    GUID code{}; CLSIDFromString(guid.c_str(), &code); memcpy(pe.data() + 520, &code, sizeof(code));
    if (!BundleBytes(pe, guid) || BundleBytes(pe, kBundleUpgrade)) return false;
    pe.resize(523); if (BundleBytes(pe, guid)) return false;
    return true;
}
DWORD ResolveCache(std::wstring& cache, File& target) {
    std::wstring product = String(kRegistry, L"MsiProductCode");
    if (!Guid(product) || Msi(product, INSTALLPROPERTY_PRODUCTSTATE) != L"5" || Msi(product, INSTALLPROPERTY_INSTALLEDPRODUCTNAME) != kProduct || Msi(product, INSTALLPROPERTY_PUBLISHER) != L"DMeloper") return ERROR_UNKNOWN_PRODUCT;
    std::wstring version = Msi(product, INSTALLPROPERTY_VERSIONSTRING);
    if (!Version(version)) return ERROR_BAD_CONFIGURATION;
    cache = RegisteredCache(version, LocalAppData());
    if (cache.empty() || !LockFile(cache, target) || !FileProduct(cache, version) || !BundleFile(target.handle, Parent(cache).substr(Parent(cache).find_last_of(L'\\') + 1))) return ERROR_FILE_NOT_FOUND;
    return ERROR_SUCCESS;
}
DWORD Resolve(const std::wstring& self, std::wstring& cache, File& own, File& target) {
    if (!LockFile(self, own)) return ERROR_BAD_PATHNAME;
    std::wstring location = Full(String(kRegistry, L"InstallLocation"));
    if (location.empty() || !Same(Final(own.handle), location + L"\\uninstall.exe") ||
        String(kRegistry, L"DeliveryMode") != kDeliveryMode || String(kRegistry, L"MsiUpgradeCode") != kMsiUpgrade || String(kRegistry, L"BundleUpgradeCode") != kBundleUpgrade) return ERROR_UNKNOWN_PRODUCT;
    return ResolveCache(cache, target);
}
}
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR arguments, int) {
    if (arguments && wcscmp(arguments, L"--bp-self-test") == 0) return SelfTest() ? 0 : 1;
    if (arguments && wcscmp(arguments, L"--bp-check-cache") == 0) { std::wstring cache; File target; return static_cast<int>(ResolveCache(cache, target)); }
    // Diagnostic resolves real registration without opening UI or starting a child.
    bool check = arguments && wcscmp(arguments, L"--bp-check-registration") == 0;
    DWORD error = ERROR_INVALID_PARAMETER;
    if (!arguments || !*arguments || check) {
        std::vector<wchar_t> module(32768);
        DWORD length = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
        std::wstring cache; File own, target;
        if (length && length < module.size()) error = Resolve(std::wstring(module.data(), length), cache, own, target);
        if (!error && !check) {
            auto command = Command(cache);
            STARTUPINFOW startup{ sizeof(startup) }; PROCESS_INFORMATION process{};
            if (!CreateProcessW(cache.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, Parent(cache).c_str(), &startup, &process)) error = GetLastError();
            else { CloseHandle(process.hThread); CloseHandle(process.hProcess); }
            // No wait: the launcher image must be released before MSI removes it.
        }
    }
    if (error && !check) {
        bool korean = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_KOREAN;
        wchar_t message[512]{};
        swprintf_s(message, korean ? L"설치된 DMeloper's Block Pet 제거 프로그램을 확인하거나 열지 못했습니다. Windows 설정의 설치된 앱에서 제거를 시도하세요.\r\n\r\n오류 코드: %lu" : L"Could not verify or open the installed DMeloper's Block Pet uninstaller. Try Windows Settings > Installed apps.\r\n\r\nError code: %lu", error);
        MessageBoxW(nullptr, message, kProduct, MB_OK | MB_ICONERROR);
    }
    return static_cast<int>(error);
}
