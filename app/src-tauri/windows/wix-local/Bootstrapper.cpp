// Native installation UI. Burn owns MSI transactions; this UI never kills apps.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <msiquery.h>
#include <string>
#include <vector>
#include <algorithm>
#include "AppExternalLinks.h"
#include "BootstrapperApplication.h"
#include "dutil.h"
#include "dictutil.h"
#include "deputil.h"
#include "BootstrapperApplicationBase.h"

namespace {
// Product presentation is independent of registration keys, GUIDs and channel identity.
constexpr wchar_t kProduct[] = L"DMeloper's Block Pet";
constexpr wchar_t kDisplayProduct[] = L"DMeloper's Block Pet";
bool RegistrationProduct(const std::wstring& name) {
    return name == kDisplayProduct;
}
#if defined(BP_OFFICIAL_BUILD)
constexpr wchar_t kRegistry[] = L"Software\\DMeloper\\BlockPet\\Github";
constexpr wchar_t kReceipts[] = L"Software\\DMeloper\\BlockPet\\GithubShortcuts";
constexpr wchar_t kMutex[] = L"Local\\DMeloper.BlockPet.Installer";
constexpr wchar_t kMsiUpgrade[] = L"{70B77E49-EDA1-59D4-AFAB-7805E2FEA6A7}";
constexpr wchar_t kBundleUpgrade[] = L"{8AD6D51E-F120-55B8-90C3-C15CD80E8173}";
constexpr wchar_t kDeliveryMode[] = L"block-pet-wix-v1";
constexpr wchar_t kUpdateReady[] = L"Local\\DMeloper.BlockPet.UpdateReady.";
constexpr wchar_t kUpdateCommit[] = L"Local\\DMeloper.BlockPet.UpdateCommit.";
#else
constexpr wchar_t kRegistry[] = L"Software\\DMeloper\\BlockPet\\WixLocal";
constexpr wchar_t kReceipts[] = L"Software\\DMeloper\\BlockPet\\WixLocalShortcuts";
constexpr wchar_t kMutex[] = L"Local\\DMeloper.BlockPet.WixLocal.Installer";
constexpr wchar_t kMsiUpgrade[] = L"{7D693AC9-0739-5A22-9237-A3506BCDE81E}";
constexpr wchar_t kBundleUpgrade[] = L"{7239299E-8103-5BC6-93F7-93D036A22F71}";
constexpr wchar_t kDeliveryMode[] = L"block-pet-wix-local-v1";
constexpr wchar_t kUpdateReady[] = L"Local\\DMeloper.BlockPet.WixLocal.UpdateReady.";
constexpr wchar_t kUpdateCommit[] = L"Local\\DMeloper.BlockPet.WixLocal.UpdateCommit.";
#endif
constexpr wchar_t kExe[] = L"dmelopers-block-pet.exe";
constexpr wchar_t kRemovalLink[] = L"Uninstall.lnk";
constexpr wchar_t kUninstallRegistry[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\";
constexpr wchar_t kDependencyRegistry[] = L"Software\\Classes\\Installer\\Dependencies\\";
constexpr UINT kDetected = WM_APP + 1, kPlanned = WM_APP + 2, kCompleted = WM_APP + 3, kProgress = WM_APP + 4, kMsiRemoved = WM_APP + 5;
constexpr int kNext = 101, kBack = 102, kCancel = 103, kFolder = 104, kBrowse = 105, kDesktop = 106, kStart = 107, kRun = 108, kDelete = 109;
constexpr int kUiWidth = 560, kUiHeight = 400, kFooterTop = 354, kHeaderBottom = 74, kSidebarWidth = 164;
std::wstring SpaceBytes(ULONGLONG bytes) {
    if (bytes < 1024) return std::to_wstring(bytes) + L" B";
    const wchar_t* units[] = { L"KiB", L"MiB", L"GiB", L"TiB", L"PiB", L"EiB" };
    double value = static_cast<double>(bytes) / 1024;
    unsigned unit = 0;
    while (value >= 1024 && unit + 1 < _countof(units)) { value /= 1024; ++unit; }
    wchar_t text[80]{}; swprintf_s(text, L"%.1f %s", value, units[unit]); return text;
}
std::wstring SpaceSummary(ULONGLONG required, bool availableKnown, ULONGLONG available, bool korean) {
    const wchar_t* unknown = korean ? L"확인할 수 없음" : L"Unavailable";
    return std::wstring(korean ? L"필요한 디스크 공간: " : L"Space required: ") + (required ? SpaceBytes(required) : unknown) +
        L"\r\n" + (korean ? L"사용 가능한 디스크 공간: " : L"Space available: ") + (availableKnown ? SpaceBytes(available) : unknown);
}
std::wstring ReadString(HKEY root, const wchar_t* key, const wchar_t* name, REGSAM view = KEY_WOW64_64KEY) {
    DWORD size = 0;
    if (RegGetValueW(root, key, name, RRF_RT_REG_SZ | ((view == KEY_WOW64_32KEY) ? RRF_SUBKEY_WOW6432KEY : RRF_SUBKEY_WOW6464KEY), nullptr, nullptr, &size) != ERROR_SUCCESS || size > 65536) return {};
    std::vector<wchar_t> buf(size / sizeof(wchar_t) + 1);
    if (RegGetValueW(root, key, name, RRF_RT_REG_SZ | ((view == KEY_WOW64_32KEY) ? RRF_SUBKEY_WOW6432KEY : RRF_SUBKEY_WOW6464KEY), nullptr, buf.data(), &size) != ERROR_SUCCESS) return {};
    return buf.data();
}
bool ReadChoice(const wchar_t* name) {
    DWORD value = 1, size = sizeof(value);
    RegGetValueW(HKEY_CURRENT_USER, kRegistry, name, RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &value, &size);
    return value != 0;
}
std::wstring FullPath(const std::wstring& path) {
    if (path.empty()) return {};
    std::vector<wchar_t> buf(32768);
    DWORD n = GetFullPathNameW(path.c_str(), static_cast<DWORD>(buf.size()), buf.data(), nullptr);
    if (!n || n >= buf.size()) return {};
    std::wstring result(buf.data());
    while (result.size() > 3 && result.back() == L'\\') result.pop_back();
    return result;
}
bool AvailableSpace(const std::wstring& input, ULONGLONG& bytes) {
    // Do not query a relative path or accidentally access a network share.
    if (input.size() < 3 || !((input[0] >= L'A' && input[0] <= L'Z') || (input[0] >= L'a' && input[0] <= L'z')) ||
        input[1] != L':' || (input[2] != L'\\' && input[2] != L'/') || input.find_first_of(L"<>\"|?*") != std::wstring::npos ||
        input.find(L':', 2) != std::wstring::npos || input.find(L'\0') != std::wstring::npos) return false;
    for (wchar_t ch : input) if (ch < L' ') return false;
    auto path = FullPath(input);
    while (!path.empty()) {
        DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES) {
            if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) return false;
            ULARGE_INTEGER available{};
            if (!GetDiskFreeSpaceExW(path.c_str(), &available, nullptr, nullptr)) return false;
            bytes = available.QuadPart; return true;
        }
        DWORD error = GetLastError();
        if ((error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) || path.size() <= 3) return false;
        auto separator = path.find_last_of(L'\\');
        if (separator == std::wstring::npos) return false;
        path.resize(separator <= 2 ? 3 : separator);
    }
    return false;
}
bool EqualPath(const std::wstring& a, const std::wstring& b) { return !a.empty() && !b.empty() && _wcsicmp(FullPath(a).c_str(), FullPath(b).c_str()) == 0; }
bool EqualText(const std::wstring& a, const std::wstring& b) { return _wcsicmp(a.c_str(), b.c_str()) == 0; }
bool ProductName(const std::wstring& name) {
    return name == kDisplayProduct || name == L"DMeloper's Block Pet WiX Local" || name == L"DMeloper's Block Pet (Independent)";
}
bool CanonicalGuid(const std::wstring& value) {
    GUID guid{}; wchar_t text[39]{};
    return value.size() == 38 && SUCCEEDED(CLSIDFromString(value.c_str(), &guid)) &&
        StringFromGUID2(guid, text, _countof(text)) == 39 && EqualText(value, text);
}
bool LocalPath(const std::wstring& path) {
    if (path.size() <= 3 || path[1] != L':' || path[2] != L'\\' || path.find(L':', 2) != std::wstring::npos ||
        path.find_first_of(L"<>\"|?*") != std::wstring::npos) return false;
    if (!((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))) return false;
    for (wchar_t ch : path) if (ch < L' ') return false;
    // Never replace an installation through a junction/symlink, including parents.
    auto node = FullPath(path);
    while (node.size() > 3) {
        DWORD attributes = GetFileAttributesW(node.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
        if (attributes == INVALID_FILE_ATTRIBUTES && GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) return false;
        auto separator = node.find_last_of(L'\\'); if (separator == std::wstring::npos) return false;
        node.resize(separator <= 2 ? 3 : separator);
    }
    return true;
}
std::wstring CurrentSid() {
    HANDLE token = nullptr; std::wstring result; DWORD size = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return {};
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    std::vector<BYTE> data(size);
    if (size && GetTokenInformation(token, TokenUser, data.data(), size, &size)) {
        PSID sid = reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid;
        DWORD count = *GetSidSubAuthorityCount(sid);
        auto authority = GetSidIdentifierAuthority(sid); ULONGLONG number = 0;
        for (BYTE value : authority->Value) number = (number << 8) | value;
        result = L"S-1-" + std::to_wstring(number);
        for (DWORD i = 0; i < count; ++i) result += L"-" + std::to_wstring(*GetSidSubAuthority(sid, i));
    }
    CloseHandle(token); return result;
}
bool MsiBufferProbe(UINT status, DWORD size) { return (status == ERROR_SUCCESS || status == ERROR_MORE_DATA) && size <= 32768; }
std::wstring MsiInfo(const std::wstring& product, const std::wstring& sid, MSIINSTALLCONTEXT context, const wchar_t* name, UINT* result = nullptr) {
    DWORD size = 0; UINT status = MsiGetProductInfoExW(product.c_str(), context == MSIINSTALLCONTEXT_MACHINE ? nullptr : sid.c_str(), context, name, nullptr, &size);
    if (result) *result = status;
    if (!MsiBufferProbe(status, size)) return {};
    std::vector<wchar_t> value(++size);
    status = MsiGetProductInfoExW(product.c_str(), context == MSIINSTALLCONTEXT_MACHINE ? nullptr : sid.c_str(), context, name, value.data(), &size);
    if (result) *result = status;
    return status == ERROR_SUCCESS ? value.data() : L"";
}
bool MsiPresent(const std::wstring& product, const std::wstring& sid) {
    return MsiInfo(product, sid, MSIINSTALLCONTEXT_USERUNMANAGED, INSTALLPROPERTY_PRODUCTSTATE) == L"5";
}
bool MsiAbsent(const std::wstring& product, const std::wstring& sid) {
    UINT status = 0; MsiInfo(product, sid, MSIINSTALLCONTEXT_USERUNMANAGED, INSTALLPROPERTY_PRODUCTSTATE, &status);
    return status == ERROR_UNKNOWN_PRODUCT;
}
bool StableProductVersion(const std::wstring& version) {
    // The official producer permits only stable X.Y.Z, without leading zeroes,
    // prerelease/build labels or components beyond its 16-bit packaging bound.
    if (version.size() < 5 || version.size() > 17) return false;
    size_t start = 0;
    for (unsigned part = 0; part < 3; ++part) {
        size_t end = version.find(L'.', start);
        if (part < 2) { if (end == std::wstring::npos) return false; }
        else { if (end != std::wstring::npos) return false; end = version.size(); }
        if (end == start || (end - start > 1 && version[start] == L'0')) return false;
        unsigned value = 0;
        for (size_t index = start; index < end; ++index) {
            wchar_t digit = version[index];
            if (digit < L'0' || digit > L'9') return false;
            value = value * 10 + static_cast<unsigned>(digit - L'0');
            if (value > 65535) return false;
        }
        start = end + 1;
    }
    return true;
}
std::wstring ProfileProductCode(const std::wstring& version) {
    if (!StableProductVersion(version)) return {};
    // RFC 4122 UUIDv5: network-order namespace + UTF-8 "product:X.Y.Z".
    // SHA-1 only derives an identity; package authentication remains SHA-256.
#if defined(BP_OFFICIAL_BUILD)
    constexpr BYTE space[] = { 0xe6, 0x54, 0x53, 0x12, 0xe3, 0x82, 0x51, 0x62, 0xb6, 0x4f, 0x49, 0x3b, 0x27, 0x2f, 0xb6, 0xad };
#else
    // Preserve the historical fixture GUIDs while accepting future test versions.
    constexpr BYTE space[] = { 0x6c, 0x92, 0x63, 0x89, 0xda, 0x1f, 0x5c, 0xa5, 0x8e, 0x76, 0xac, 0xad, 0x2b, 0x87, 0xcc, 0x72 };
#endif
    std::vector<BYTE> input(space, space + _countof(space));
    for (char value : std::string("product:")) input.push_back(static_cast<BYTE>(value));
    for (wchar_t value : version) input.push_back(static_cast<BYTE>(value));
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD objectSize = 0, received = 0; BYTE digest[20]{}; bool ok = false;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA1_ALGORITHM, nullptr, 0) == 0 &&
        BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &received, 0) == 0 &&
        objectSize > 0 && objectSize <= 65536) {
        std::vector<BYTE> object(objectSize);
        if (BCryptCreateHash(algorithm, &hash, object.data(), objectSize, nullptr, 0, 0) == 0) {
            ok = BCryptHashData(hash, input.data(), static_cast<ULONG>(input.size()), 0) == 0 &&
                BCryptFinishHash(hash, digest, sizeof(digest), 0) == 0;
            BCryptDestroyHash(hash);
        }
    }
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!ok) return {};
    digest[6] = (digest[6] & 0x0f) | 0x50; digest[8] = (digest[8] & 0x3f) | 0x80;
    constexpr wchar_t digits[] = L"0123456789ABCDEF";
    std::wstring result = L"{";
    for (unsigned index = 0; index < 16; ++index) {
        if (index == 4 || index == 6 || index == 8 || index == 10) result += L'-';
        result += digits[digest[index] >> 4]; result += digits[digest[index] & 15];
    }
    return result + L"}";
}
std::wstring KnownProductCode(const std::wstring& version) {
    return ProfileProductCode(version);
}
bool ProductAbsentEverywhere(const std::wstring& product, const std::wstring& sid) {
    if (!CanonicalGuid(product) || sid.empty()) return false;
    for (MSIINSTALLCONTEXT context : { MSIINSTALLCONTEXT_USERUNMANAGED, MSIINSTALLCONTEXT_USERMANAGED, MSIINSTALLCONTEXT_MACHINE }) {
        UINT status = 0; MsiInfo(product, sid, context, INSTALLPROPERTY_PRODUCTSTATE, &status);
        if (status != ERROR_UNKNOWN_PRODUCT) return false;
    }
    return true;
}
bool GhostEvidenceAccepted(bool unchanged, bool absent, bool protectedCandidate, bool self) {
    return unchanged && !self && (absent || protectedCandidate);
}
std::wstring MsiCell(MSIHANDLE database, const std::wstring& query) {
    MSIHANDLE view = 0, row = 0; std::wstring result;
    if (MsiDatabaseOpenViewW(database, query.c_str(), &view) == ERROR_SUCCESS && MsiViewExecute(view, 0) == ERROR_SUCCESS && MsiViewFetch(view, &row) == ERROR_SUCCESS) {
        DWORD size = 0;
        UINT status = MsiRecordGetStringW(row, 1, nullptr, &size);
        if (MsiBufferProbe(status, size)) {
            std::vector<wchar_t> value(++size);
            if (MsiRecordGetStringW(row, 1, value.data(), &size) == ERROR_SUCCESS) result = value.data();
        }
    }
    if (row) MsiCloseHandle(row); if (view) { MsiViewClose(view); MsiCloseHandle(view); } return result;
}
std::wstring MsiProperty(MSIHANDLE database, const wchar_t* name) {
    return MsiCell(database, std::wstring(L"SELECT `Value` FROM `Property` WHERE `Property`='") + name + L"'");
}
struct ProductIdentity {
    std::wstring product, package, version, localPackage, root, sid;
};
bool MsiIdentity(const std::wstring& file, ProductIdentity& identity) {
    if (!LocalPath(file)) return false;
    MSIHANDLE database = 0, summary = 0; bool ok = false;
    if (MsiOpenDatabaseW(file.c_str(), MSIDBOPEN_READONLY, &database) != ERROR_SUCCESS) return false;
    identity.product = MsiProperty(database, L"ProductCode");
    identity.version = MsiProperty(database, L"ProductVersion");
    auto channel = MsiCell(database, std::wstring(L"SELECT `Value` FROM `Registry` WHERE `Key`='") + kRegistry + L"' AND `Name`='DeliveryMode'");
    auto msiUpgrade = MsiCell(database, std::wstring(L"SELECT `Value` FROM `Registry` WHERE `Key`='") + kRegistry + L"' AND `Name`='MsiUpgradeCode'");
    auto bundleUpgrade = MsiCell(database, std::wstring(L"SELECT `Value` FROM `Registry` WHERE `Key`='") + kRegistry + L"' AND `Name`='BundleUpgradeCode'");
    if (CanonicalGuid(identity.product) && ProductName(MsiProperty(database, L"ProductName")) && MsiProperty(database, L"Manufacturer") == L"DMeloper" &&
        EqualText(MsiProperty(database, L"UpgradeCode"), kMsiUpgrade) && channel == kDeliveryMode && EqualText(msiUpgrade, kMsiUpgrade) && EqualText(bundleUpgrade, kBundleUpgrade) &&
        MsiGetSummaryInformationW(database, nullptr, 0, &summary) == ERROR_SUCCESS) {
        UINT type = 0; INT integer = 0; FILETIME time{}; DWORD size = 0;
        UINT status = MsiSummaryInfoGetPropertyW(summary, 9, &type, &integer, &time, nullptr, &size);
        if (MsiBufferProbe(status, size)) {
            std::vector<wchar_t> package(++size);
            if (MsiSummaryInfoGetPropertyW(summary, 9, &type, &integer, &time, package.data(), &size) == ERROR_SUCCESS) identity.package = package.data();
        }
        ok = CanonicalGuid(identity.package);
    }
    if (summary) MsiCloseHandle(summary); MsiCloseHandle(database); return ok;
}
bool ReadOwnedProduct(const std::wstring& product, const std::wstring& sid, ProductIdentity& identity) {
    if (!CanonicalGuid(product) || sid.empty() || !MsiPresent(product, sid)) return false;
    // A same-code machine/managed registration would make maintenance ambiguous.
    UINT machine = 0, managed = 0;
    MsiInfo(product, sid, MSIINSTALLCONTEXT_MACHINE, INSTALLPROPERTY_PRODUCTSTATE, &machine);
    MsiInfo(product, sid, MSIINSTALLCONTEXT_USERMANAGED, INSTALLPROPERTY_PRODUCTSTATE, &managed);
    if (machine != ERROR_UNKNOWN_PRODUCT || managed != ERROR_UNKNOWN_PRODUCT) return false;
    auto file = MsiInfo(product, sid, MSIINSTALLCONTEXT_USERUNMANAGED, INSTALLPROPERTY_LOCALPACKAGE);
    if (!MsiIdentity(file, identity) || !EqualText(identity.product, product) ||
        !EqualText(identity.package, MsiInfo(product, sid, MSIINSTALLCONTEXT_USERUNMANAGED, INSTALLPROPERTY_PACKAGECODE)) ||
        identity.version != MsiInfo(product, sid, MSIINSTALLCONTEXT_USERUNMANAGED, INSTALLPROPERTY_VERSIONSTRING)) return false;
    identity.sid = sid; identity.localPackage = file; return true;
}
std::wstring KnownFolder(REFKNOWNFOLDERID id) {
    PWSTR path = nullptr;
    if (FAILED(SHGetKnownFolderPath(id, 0, nullptr, &path))) return {};
    std::wstring result(path); CoTaskMemFree(path); return result;
}
enum class SidRelationship { Same, Different, Unknown };
SidRelationship CompareSid(HANDLE process) {
    HANDLE currentToken = nullptr, targetToken = nullptr;
    SidRelationship relationship = SidRelationship::Unknown;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &currentToken) && OpenProcessToken(process, TOKEN_QUERY, &targetToken)) {
        DWORD a = 0, b = 0;
        GetTokenInformation(currentToken, TokenUser, nullptr, 0, &a);
        GetTokenInformation(targetToken, TokenUser, nullptr, 0, &b);
        std::vector<BYTE> current(a), target(b);
        if (a && b && GetTokenInformation(currentToken, TokenUser, current.data(), a, &a) && GetTokenInformation(targetToken, TokenUser, target.data(), b, &b))
            relationship = EqualSid(reinterpret_cast<TOKEN_USER*>(current.data())->User.Sid, reinterpret_cast<TOKEN_USER*>(target.data())->User.Sid)
                ? SidRelationship::Same : SidRelationship::Different;
    }
    if (currentToken) CloseHandle(currentToken);
    if (targetToken) CloseHandle(targetToken);
    return relationship;
}
bool SameSid(HANDLE process) { return CompareSid(process) == SidRelationship::Same; }
std::wstring ProcessPath(HANDLE process) {
    std::vector<wchar_t> path(32768); DWORD n = static_cast<DWORD>(path.size());
    return QueryFullProcessImageNameW(process, 0, path.data(), &n) ? std::wstring(path.data(), n) : std::wstring();
}
struct ProcessProbe {
    HANDLE Snapshot() const { return CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0); }
    BOOL First(HANDLE snapshot, PROCESSENTRY32W& entry) const { return Process32FirstW(snapshot, &entry); }
    BOOL Next(HANDLE snapshot, PROCESSENTRY32W& entry) const { return Process32NextW(snapshot, &entry); }
    DWORD Error() const { return GetLastError(); }
    HANDLE Open(DWORD pid) const { return OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid); }
    DWORD Wait(HANDLE process) const { return WaitForSingleObject(process, 0); }
    std::wstring Image(HANDLE process) const { return ProcessPath(process); }
    SidRelationship Sid(HANDLE process) const { return CompareSid(process); }
    void Close(HANDLE handle) const { CloseHandle(handle); }
};
template<typename Probe>
bool RunningAt(const std::wstring& exe, Probe& probe) {
    HANDLE snapshot = probe.Snapshot();
    if (snapshot == INVALID_HANDLE_VALUE) return true; // Fail closed on an unavailable process inventory.
    PROCESSENTRY32W entry{ sizeof(entry) }; bool running = false;
    BOOL entryAvailable = probe.First(snapshot, entry);
    while (entryAvailable) {
        // Unrelated protected/system processes never need to be opened.
        if (_wcsicmp(entry.szExeFile, kExe) == 0) {
            HANDLE process = probe.Open(entry.th32ProcessID);
            if (!process) { running = true; break; }
            DWORD waited = probe.Wait(process);
            if (waited != WAIT_OBJECT_0) {
                auto image = waited == WAIT_TIMEOUT ? probe.Image(process) : std::wstring();
                // Unknown image/token is not evidence that this installation is
                // absent. Only a confirmed exit or a known different identity
                // permits mutation; preserve the existing other-user behavior.
                running = image.empty() || (EqualPath(image, exe) && probe.Sid(process) != SidRelationship::Different);
                if (running && probe.Wait(process) == WAIT_OBJECT_0) running = false;
            }
            probe.Close(process);
            if (running) break;
        }
        entryAvailable = probe.Next(snapshot, entry);
    }
    // Capture enumeration failure before CloseHandle can overwrite last error.
    if (!entryAvailable) running = probe.Error() != ERROR_NO_MORE_FILES;
    probe.Close(snapshot); return running;
}
bool RunningAt(const std::wstring& exe) { ProcessProbe probe; return RunningAt(exe, probe); }
#if defined(BP_BA_SELF_TEST)
bool TestProcessProbe() {
    struct Candidate {
        const wchar_t* name; std::wstring image;
        SidRelationship sid = SidRelationship::Unknown;
        bool open = true; DWORD wait = WAIT_TIMEOUT; bool exitsDuringQuery = false;
    };
    struct Probe {
        std::vector<Candidate> candidates;
        bool snapshotFailure = false;
        DWORD firstError = ERROR_NO_MORE_FILES, nextError = ERROR_NO_MORE_FILES, error = 0;
        size_t index = 0; unsigned opens = 0, closed = 0, waits = 0;
        HANDLE Snapshot() const { return snapshotFailure ? INVALID_HANDLE_VALUE : reinterpret_cast<HANDLE>(1); }
        BOOL Entry(PROCESSENTRY32W& entry) {
            wcscpy_s(entry.szExeFile, candidates[index].name);
            entry.th32ProcessID = static_cast<DWORD>(index + 1); return TRUE;
        }
        BOOL First(HANDLE, PROCESSENTRY32W& entry) {
            index = 0;
            if (candidates.empty() || firstError != ERROR_NO_MORE_FILES) { error = firstError; return FALSE; }
            return Entry(entry);
        }
        BOOL Next(HANDLE, PROCESSENTRY32W& entry) {
            if (++index >= candidates.size()) { error = nextError; return FALSE; }
            return Entry(entry);
        }
        DWORD Error() const { return error; }
        HANDLE Open(DWORD) { ++opens; waits = 0; return candidates[index].open ? reinterpret_cast<HANDLE>(2) : nullptr; }
        DWORD Wait(HANDLE) { return ++waits > 1 && candidates[index].exitsDuringQuery ? WAIT_OBJECT_0 : candidates[index].wait; }
        std::wstring Image(HANDLE) const { return candidates[index].image; }
        SidRelationship Sid(HANDLE) const { return candidates[index].sid; }
        void Close(HANDLE) { ++closed; error = ERROR_INVALID_HANDLE; } // Must not hide a captured enumeration error.
    };
    const std::wstring target = L"C:\\Unicode 시험\\dmelopers-block-pet.exe";
    Probe probe;
    if (RunningAt(target, probe) || probe.opens || probe.closed != 1) return false;
    probe = {}; probe.snapshotFailure = true;
    if (!RunningAt(target, probe) || probe.opens || probe.closed) return false;
    probe = {}; probe.firstError = ERROR_ACCESS_DENIED;
    if (!RunningAt(target, probe) || probe.closed != 1) return false;
    probe = {}; probe.candidates = { { L"protected-system.exe", L"", SidRelationship::Unknown, false } };
    if (RunningAt(target, probe) || probe.opens) return false;
    probe = {}; probe.candidates = { { kExe, L"C:\\Other\\dmelopers-block-pet.exe" } };
    if (RunningAt(target, probe) || probe.opens != 1) return false;
    probe = {}; probe.candidates = { { kExe, target, SidRelationship::Different } };
    if (RunningAt(target, probe)) return false;
    probe = {}; probe.candidates = { { kExe, target, SidRelationship::Same } };
    if (!RunningAt(target, probe)) return false;
    probe = {}; probe.candidates = { { kExe, target, SidRelationship::Unknown } };
    if (!RunningAt(target, probe)) return false;
    probe = {}; probe.candidates = { { kExe, L"" } };
    if (!RunningAt(target, probe)) return false;
    probe = {}; probe.candidates = { { kExe, target, SidRelationship::Same, false } };
    if (!RunningAt(target, probe)) return false;
    probe = {}; probe.candidates = { { kExe, target, SidRelationship::Same, true, WAIT_FAILED } };
    if (!RunningAt(target, probe)) return false;
    probe = {}; probe.candidates = { { kExe, L"", SidRelationship::Unknown, true, WAIT_OBJECT_0 } };
    if (RunningAt(target, probe)) return false;
    probe = {}; probe.candidates = { { kExe, L"", SidRelationship::Unknown, true, WAIT_TIMEOUT, true } };
    if (RunningAt(target, probe)) return false;
    probe = {}; probe.candidates = { { L"other.exe", L"" } }; probe.nextError = ERROR_ACCESS_DENIED;
    if (!RunningAt(target, probe)) return false;
    probe = {}; probe.candidates = { { L"other.exe", L"" }, { kExe, target, SidRelationship::Same } };
    return RunningAt(target, probe) && probe.opens == 1 && probe.closed == 2;
}
#endif
std::wstring FileHash(const std::wstring& file) {
    HANDLE input = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (input == INVALID_HANDLE_VALUE) return {};
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(input, &info) || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) { CloseHandle(input); return {}; }
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
    std::wstring result; DWORD objectSize = 0, received = 0; BYTE digest[32];
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0 &&
        BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &received, 0) == 0) {
        std::vector<BYTE> object(objectSize), buffer(65536);
        if (BCryptCreateHash(algorithm, &hash, object.data(), objectSize, nullptr, 0, 0) == 0) {
            bool ok = true; DWORD count = 0;
            while (true) {
                if (!ReadFile(input, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr)) { ok = false; break; }
                if (!count) break;
                if (BCryptHashData(hash, buffer.data(), count, 0) != 0) { ok = false; break; }
            }
            if (ok && BCryptFinishHash(hash, digest, sizeof(digest), 0) == 0) {
                constexpr wchar_t digits[] = L"0123456789abcdef";
                for (BYTE value : digest) { result += digits[value >> 4]; result += digits[value & 15]; }
            }
            BCryptDestroyHash(hash);
        }
    }
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    CloseHandle(input); return result;
}
bool WriteReceipt(const wchar_t* name, const std::wstring& value) {
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kReceipts, 0, nullptr, 0, KEY_SET_VALUE | KEY_WOW64_64KEY, nullptr, &key, nullptr) != ERROR_SUCCESS) return false;
    bool ok = RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()), static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS;
    RegCloseKey(key); return ok;
}
bool RemoveOwnedFile(const std::wstring& path, const std::wstring& expected) {
    if (expected.empty()) return true;
    // Deny writes/rename while hashing. Delete by the held handle rather than
    // resolving the path again, so a replacement shortcut is never removed.
    HANDLE owned = CreateFileW(path.c_str(), GENERIC_READ | DELETE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (owned == INVALID_HANDLE_VALUE) { DWORD error = GetLastError(); return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND; }
    auto actual = FileHash(path); bool ok = true;
    if (!actual.empty() && actual == expected) { FILE_DISPOSITION_INFO disposition{ TRUE }; ok = SetFileInformationByHandle(owned, FileDispositionInfo, &disposition, sizeof(disposition)) != FALSE; }
    CloseHandle(owned); return ok;
}
bool ShortcutFile(const std::wstring& path, const std::wstring& target, const std::wstring& arguments,
                  const std::wstring& description, const std::wstring& icon, const std::wstring& expected,
                  bool remove, bool refreshOwned, std::wstring& digest) {
    digest.clear();
    auto folder = path.substr(0, path.find_last_of(L"\\"));
    if (folder.empty()) return false;
    if (remove) return RemoveOwnedFile(path, expected);
    if (refreshOwned && !expected.empty() && !RemoveOwnedFile(path, expected)) return false;
    if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) return true; // Existing user/foreign bytes are preserved.
    IShellLinkW* link = nullptr; IPersistFile* persisted = nullptr; bool ok = false;
    if (SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) {
        if (SUCCEEDED(link->SetPath(target.c_str())) && SUCCEEDED(link->SetWorkingDirectory(target.substr(0, target.find_last_of(L"\\")).c_str())) &&
            SUCCEEDED(link->SetArguments(arguments.c_str())) && SUCCEEDED(link->SetDescription(description.c_str())) &&
            (icon.empty() || SUCCEEDED(link->SetIconLocation(icon.c_str(), 0))) && SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(&persisted)))) {
            wchar_t temp[MAX_PATH]{};
            if (GetTempFileNameW(folder.c_str(), L"bpl", 0, temp)) {
                if (SUCCEEDED(persisted->Save(temp, TRUE)) && MoveFileExW(temp, path.c_str(), MOVEFILE_WRITE_THROUGH)) {
                    digest = FileHash(path); ok = !digest.empty();
                }
                DeleteFileW(temp);
            }
        }
    }
    if (persisted) persisted->Release();
    if (link) link->Release();
    return ok;
}
bool ProductShortcutFile(const std::wstring& folder, const std::wstring& target, const std::wstring& expected, bool remove, std::wstring& digest) {
    if (folder.empty()) return false;
    bool ok = true;
    for (const wchar_t* legacy : { L"DMeloper's Block Pet WiX Local", L"DMeloper's Block Pet (Independent)" })
        ok &= RemoveOwnedFile(folder + L"\\" + legacy + L".lnk", expected);
    ok &= ShortcutFile(folder + L"\\" + kProduct + L".lnk", target, L"", kDisplayProduct, L"", expected, remove, true, digest);
    return ok;
}
bool Shortcut(const std::wstring& folder, const std::wstring& target, const wchar_t* receipt, bool remove) {
    std::wstring digest;
    bool ok = ProductShortcutFile(folder, target, ReadString(HKEY_CURRENT_USER, kReceipts, receipt), remove, digest);
    return ok && (digest.empty() || WriteReceipt(receipt, digest));
}
std::wstring RemovalCachePath(const std::wstring& local, const std::wstring& bundle, const std::wstring& version) {
    GUID parsed{};
    if (local.size() < 3 || local[1] != L':' || local[2] != L'\\' || local.find(L'"') != std::wstring::npos ||
        bundle.size() != 38 || bundle.front() != L'{' || bundle.back() != L'}' || FAILED(CLSIDFromString(bundle.c_str(), &parsed))) return {};
    unsigned parts = 0; size_t offset = 0;
    while (offset < version.size()) {
        size_t start = offset; unsigned value = 0;
        while (offset < version.size() && version[offset] >= L'0' && version[offset] <= L'9') {
            value = value * 10 + static_cast<unsigned>(version[offset++] - L'0');
            if (value > 65535) return {};
        }
        if (offset == start || (offset - start > 1 && version[start] == L'0')) return {};
        ++parts;
        if (offset == version.size()) break;
        if (version[offset++] != L'.' || offset == version.size()) return {};
    }
    if (parts != 3) return {};
    return FullPath(local) + L"\\Package Cache\\" + bundle + L"\\dmelopers-block-pet_" + version + L"_x64-setup.exe";
}
#if defined(BP_BA_SELF_TEST)
bool TestRemovalShortcut() {
    std::wstring bundle = L"{8C62790B-5FE7-4787-B501-6AF0F6FF8236}";
    std::wstring local = L"C:\\Users\\Unicode 한글 😶安★\\AppData\\Local";
    auto first = RemovalCachePath(local, bundle, L"1.0.0"), second = RemovalCachePath(local, bundle, L"1.0.1");
    if (first != local + L"\\Package Cache\\" + bundle + L"\\dmelopers-block-pet_1.0.0_x64-setup.exe" ||
        second != local + L"\\Package Cache\\" + bundle + L"\\dmelopers-block-pet_1.0.1_x64-setup.exe") return false;
    for (const wchar_t* invalid : { L"", L"1.0", L"1.0.0.0", L"1.0.0 /quiet", L"01.0.0", L"1.0.", L"1.0.65536" }) if (!RemovalCachePath(local, bundle, invalid).empty()) return false;
    if (!RemovalCachePath(local, bundle + L" /quiet", L"1.0.0").empty() || !RemovalCachePath(L"relative", bundle, L"1.0.0").empty()) return false;
    HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized)) return false;
    wchar_t temporary[MAX_PATH]{}, reservation[MAX_PATH]{};
    bool ok = GetTempPathW(MAX_PATH, temporary) && GetTempFileNameW(temporary, L"bpl", 0, reservation);
    auto folder = std::wstring(reservation) + L"-한글 😶安★";
    auto path = folder + L"\\" + kRemovalLink, icon = folder + L"\\" + kExe;
    ok = ok && CreateDirectoryW(folder.c_str(), nullptr);
    auto read = [&](const std::wstring& target) {
        IShellLinkW* link = nullptr; IPersistFile* file = nullptr; bool valid = false;
        if (SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) &&
            SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(&file))) && SUCCEEDED(file->Load(path.c_str(), STGM_READ))) {
            wchar_t stored[32768]{}, arguments[128]{}, picture[32768]{}, working[32768]{}; int index = -1;
            valid = SUCCEEDED(link->GetPath(stored, 32768, nullptr, SLGP_RAWPATH)) && EqualPath(stored, target) &&
                    SUCCEEDED(link->GetArguments(arguments, 128)) && std::wstring(arguments) == L"/uninstall" &&
                    SUCCEEDED(link->GetIconLocation(picture, 32768, &index)) && EqualPath(picture, icon) && index == 0 &&
                    SUCCEEDED(link->GetWorkingDirectory(working, 32768)) && EqualPath(working, target.substr(0, target.find_last_of(L"\\")));
        }
        if (file) file->Release(); if (link) link->Release(); return valid;
    };
    std::wstring original, updated, ignored;
    if (ok) ok = ShortcutFile(path, first, L"/uninstall", kProduct, icon, L"", false, true, original) && !original.empty() && read(first);
    if (ok) ok = ShortcutFile(path, second, L"/uninstall", kProduct, icon, L"", false, true, ignored) && ignored.empty() && read(first); // Foreign/unowned bytes.
    if (ok) ok = ShortcutFile(path, second, L"/uninstall", kProduct, icon, original, false, true, updated) && !updated.empty() && read(second); // Upgrade refresh.
    if (ok) {
        HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        DWORD written = 0; BYTE edit = 1;
        ok = file != INVALID_HANDLE_VALUE && WriteFile(file, &edit, 1, &written, nullptr) && written == 1;
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    }
    auto edited = FileHash(path);
    if (ok) ok = !edited.empty() && edited != updated && ShortcutFile(path, first, L"/uninstall", kProduct, icon, updated, false, true, ignored) && ignored.empty() && FileHash(path) == edited;
    if (ok) ok = ShortcutFile(path, L"", L"", L"", L"", updated, true, true, ignored) && FileHash(path) == edited; // Edited link survives removal.
    if (ok) ok = ShortcutFile(path, L"", L"", L"", L"", edited, true, true, ignored) && GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES;
    DeleteFileW(path.c_str()); RemoveDirectoryW(folder.c_str()); DeleteFileW(reservation);
    CoUninitialize(); return ok;
}
#endif
std::wstring Quote(const std::wstring& value) {
    // CommandLineToArgvW inverse: preserve trailing backslashes before closing quote.
    std::wstring out = L"\""; size_t slash = 0;
    for (wchar_t c : value) {
        if (c == L'\\') { ++slash; continue; }
        if (c == L'\"') out.append(slash * 2 + 1, L'\\'); else out.append(slash, L'\\');
        slash = 0; out += c;
    }
    out.append(slash * 2, L'\\'); out += L'\"'; return out;
}
bool OwnedRunValue(const std::wstring& value, const std::wstring& exe) {
    return value == Quote(exe) || value == Quote(exe) + L" ";
}
bool WebViewAvailable() {
    constexpr wchar_t key[] = L"SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    for (HKEY root : { HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE }) for (REGSAM view : { KEY_WOW64_32KEY, KEY_WOW64_64KEY }) {
        auto version = ReadString(root, key, L"pv", view);
        wchar_t* end = nullptr; unsigned long major = wcstoul(version.c_str(), &end, 10);
        if (end && *end == L'.' && major >= 120) return true;
    }
    return false;
}
bool BlockAppWithoutWebView(LPCWSTR package, BOOL execute, BOOTSTRAPPER_ACTION_STATE action,
                           bool managed, bool available) {
    return managed && execute && package && wcscmp(package, L"Application") == 0 &&
        (action == BOOTSTRAPPER_ACTION_STATE_INSTALL || action == BOOTSTRAPPER_ACTION_STATE_REPAIR) && !available;
}
bool ReadWindowsRevision(DWORD& revision) {
    DWORD bytes = sizeof(revision);
    return RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", L"UBR",
        RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &revision, &bytes) == ERROR_SUCCESS && bytes == sizeof(revision);
}
bool MinimumPlatform(DWORD build, DWORD revision, bool revisionKnown, WORD architecture) {
    if (architecture != PROCESSOR_ARCHITECTURE_AMD64) return false;
    if (build == 19045) return revisionKnown && revision >= 3448;
    if (build == 22621) return revisionKnown && revision >= 2283;
    return build > 22621;
}
HRESULT CALLBACK WebViewGuideCallback(HWND window, UINT notification, WPARAM, LPARAM parameter, LONG_PTR context) {
    auto guide = reinterpret_cast<LPCWSTR>(context);
    if (notification == TDN_HYPERLINK_CLICKED && parameter && guide &&
        wcscmp(reinterpret_cast<LPCWSTR>(parameter), guide) == 0)
        ShellExecuteW(window, L"open", guide, nullptr, nullptr, SW_SHOWNORMAL);
    return S_OK;
}
bool AutomaticDisplay(BOOTSTRAPPER_DISPLAY display) {
    return display == BOOTSTRAPPER_DISPLAY_NONE || display == BOOTSTRAPPER_DISPLAY_PASSIVE;
}
std::wstring ErrorCodeText(HRESULT hr, bool korean) {
    DWORD code = HRESULT_FACILITY(hr) == FACILITY_WIN32 ? HRESULT_CODE(hr) : static_cast<DWORD>(hr);
    wchar_t value[80]{};
    swprintf_s(value, L"0x%08lX (%lu)", static_cast<DWORD>(hr), code);
    return std::wstring(korean ? L"오류 코드: " : L"Error code: ") + value;
}
std::wstring FailureText(HRESULT hr, bool korean) {
    DWORD code = HRESULT_FACILITY(hr) == FACILITY_WIN32 ? HRESULT_CODE(hr) : static_cast<DWORD>(hr);
    LPWSTR buffer = nullptr;
    DWORD count = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, code, 0, reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
    std::wstring message = ErrorCodeText(hr, korean);
    if (count && buffer) {
        std::wstring description(buffer, count);
        while (!description.empty() && (description.back() == L'\r' || description.back() == L'\n' || description.back() == L' ')) description.pop_back();
        if (!description.empty()) message += L"\r\n\r\n" + description;
    }
    if (buffer) LocalFree(buffer);
    if (code == ERROR_PRODUCT_VERSION) {
        message += korean ? L"\r\n\r\n기존 설치와 현재 설치 파일이 충돌했습니다. Windows 설정의 설치된 앱에서 기존 앱을 제거하되, 사용자 데이터 삭제는 선택하지 마세요. 그 뒤 다시 설치할 수 있습니다."
            : L"\r\n\r\nThe existing installation conflicts with this setup package. Remove the existing app from Windows Settings > Installed apps, leaving user data removal unchecked, then retry installation.";
    }
    message += korean ? L"\r\n\r\n문제를 확인한 뒤 처음 화면에서 다시 시도할 수 있습니다." : L"\r\n\r\nAfter addressing the problem, you can retry from the first page.";
    return message;
}
}

class BlockPetBootstrapper final : public CBootstrapperApplicationBase {
    HINSTANCE instance_ = GetModuleHandleW(nullptr);
    HWND window_ = nullptr, heading_ = nullptr, subtitle_ = nullptr, text_ = nullptr, group_ = nullptr, details_ = nullptr, space_ = nullptr, path_ = nullptr, edit_ = nullptr, browse_ = nullptr, desktopBox_ = nullptr, startBox_ = nullptr, runBox_ = nullptr, deleteBox_ = nullptr, progress_ = nullptr, next_ = nullptr, back_ = nullptr, cancel_ = nullptr;
    HFONT font_ = nullptr, titleFont_ = nullptr, welcomeFont_ = nullptr;
    HICON artworkIcon_ = nullptr;
    HANDLE uiThread_ = nullptr, ready_ = nullptr, mutex_ = nullptr;
    std::wstring directory_, registered_, rawCommand_, attempt_;
    ProductIdentity current_, candidate_, oldProduct_;
    std::wstring candidateSha_, oldRoot_, selectedRoot_, sid_, oldRun_, oldRunName_;
    struct Ghost { std::wstring code, version, cache, provider, displayName; };
    std::vector<Ghost> ghosts_, oldBundles_;
    enum class Phase { Normal, Prepare, ReadyToRemove, RemoveBurn, RemoveMsi, Redetect, Install };
    Phase phase_ = Phase::Normal;
    bool identityValid_ = false, hasCurrent_ = false, replacement_ = false, oldRemoved_ = false, directRemoval_ = false;
    bool forceFamilyRemoval_ = false, prepared_ = false, selectionMade_ = false, newInstalled_ = false;
    BOOTSTRAPPER_ACTION_STATE plannedApplication_ = BOOTSTRAPPER_ACTION_STATE_NONE;
    HANDLE removalThread_ = nullptr;
    bool korean_ = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_KOREAN;
    bool update_ = false, restart_ = false, desktop_ = true, start_ = true, deleteData_ = false, remove_ = false, installed_ = false, automatic_ = false, related_ = false;
    bool removalLink_ = true;
    bool managedWebView_ = false, webviewFailed_ = false;
    bool active_ = false, finished_ = false, failed_ = false;
    bool quiet_ = false, passive_ = false;
    bool rebootRequired_ = false;
    bool detected_ = false, eligibleCleanup_ = false, applyStarted_ = false;
    bool detecting_ = false, retryDetect_ = false, notifyDetectError_ = true;
    HRESULT lastFailure_ = S_OK;
    DWORD parentPid_ = 0; ULONGLONG parentCreated_ = 0; DWORD exitCode_ = ERROR_INSTALL_USEREXIT;
    UINT dpi_ = 96;
    ULONGLONG installedSize_ = 0;
    int page_ = 0;
    BOOTSTRAPPER_ACTION action_ = BOOTSTRAPPER_ACTION_INSTALL;
    LPCWSTR T(LPCWSTR korean, LPCWSTR english) const { return korean_ ? korean : english; }
    bool Unattended() const { return quiet_ || passive_ || related_; }
    bool InteractiveRetry() const { return !automatic_ && !update_ && !related_ && !quiet_ && !passive_; }
    void Error(const std::wstring& message) {
        if (Unattended()) m_pEngine->Log(BOOTSTRAPPER_LOG_LEVEL_ERROR, message.c_str());
        else MessageBoxW(window_, message.c_str(), kDisplayProduct, MB_OK | MB_ICONERROR);
    }
    void Warning(const std::wstring& message) {
        if (Unattended()) m_pEngine->Log(BOOTSTRAPPER_LOG_LEVEL_STANDARD, message.c_str());
        else MessageBoxW(window_, message.c_str(), kDisplayProduct, MB_OK | MB_ICONWARNING);
    }
    void Close(DWORD code) { exitCode_ = code; if (window_) DestroyWindow(window_); }
    void Cancel() {
        if (!active_) { Close(finished_ ? exitCode_ : ERROR_INSTALL_USEREXIT); return; }
        if (Unattended() || MessageBoxW(window_, T(L"진행 중인 설치 작업을 취소할까요?", L"Cancel the installation in progress?"), kDisplayProduct, MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) == IDYES) {
            EnterCriticalSection(&m_csCanceled); m_fCanceled = TRUE; LeaveCriticalSection(&m_csCanceled);
            EnableWindow(cancel_, FALSE);
            SetWindowTextW(text_, T(L"취소 요청을 처리하고 있습니다. 잠시 기다려 주세요.", L"Setup is processing your cancellation. Please wait."));
        }
    }
    std::wstring Exe() const { return directory_ + L"\\" + kExe; }
    std::wstring OldExe() const { return oldRoot_ + L"\\" + kExe; }
    std::wstring EngineString(const wchar_t* name) const {
        wchar_t value[32768]{}; SIZE_T size = _countof(value);
        return SUCCEEDED(m_pEngine->GetVariableString(name, value, &size)) ? value : L"";
    }
    bool ProbeProducts() {
        identityValid_ = false; hasCurrent_ = false; current_ = {};
        sid_ = CurrentSid(); if (sid_.empty()) return false;
#if defined(BP_OFFICIAL_BUILD)
        // No historical private NSIS fixture is an approved official upgrade source.
        HKEY legacy = nullptr;
        LSTATUS legacyStatus = RegOpenKeyExW(HKEY_CURRENT_USER,
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DMeloper's Block Pet",
            0, KEY_READ | KEY_WOW64_64KEY, &legacy);
        if (legacy) RegCloseKey(legacy);
        if (legacyStatus != ERROR_FILE_NOT_FOUND && legacyStatus != ERROR_PATH_NOT_FOUND) return false;
#endif

        UINT machine = 0, managed = 0;
        MsiInfo(candidate_.product, sid_, MSIINSTALLCONTEXT_MACHINE, INSTALLPROPERTY_PRODUCTSTATE, &machine);
        MsiInfo(candidate_.product, sid_, MSIINSTALLCONTEXT_USERMANAGED, INSTALLPROPERTY_PRODUCTSTATE, &managed);
        if (machine != ERROR_UNKNOWN_PRODUCT || managed != ERROR_UNKNOWN_PRODUCT) return false;
        std::vector<std::wstring> family;
        for (DWORD index = 0;; ++index) {
            wchar_t code[39]{};
            UINT status = MsiEnumRelatedProductsW(kMsiUpgrade, 0, index, code);
            if (status == ERROR_NO_MORE_ITEMS) break;
            if (status != ERROR_SUCCESS) return false;
            family.emplace_back(code);
        }
        for (DWORD index = 0;; ++index) {
            wchar_t code[39]{}, owner[256]{}; DWORD length = _countof(owner); MSIINSTALLCONTEXT context{};
            UINT status = MsiEnumProductsExW(nullptr, sid_.c_str(), MSIINSTALLCONTEXT_USERUNMANAGED, index, code, &context, owner, &length);
            if (status == ERROR_NO_MORE_ITEMS) break;
            if (status != ERROR_SUCCESS || context != MSIINSTALLCONTEXT_USERUNMANAGED || !EqualText(owner, sid_)) return false;
            if (!std::any_of(family.begin(), family.end(), [&](const std::wstring& member) { return EqualText(member, code); })) continue;
            ProductIdentity identity;
            if (!ReadOwnedProduct(code, sid_, identity) || hasCurrent_) return false;
            current_ = identity; hasCurrent_ = true;
        }
        registered_ = FullPath(ReadString(HKEY_CURRENT_USER, kRegistry, L"InstallLocation"));
        if (hasCurrent_) {
            if (!LocalPath(registered_) || ReadString(HKEY_CURRENT_USER, kRegistry, L"DeliveryMode") != kDeliveryMode ||
                !EqualText(ReadString(HKEY_CURRENT_USER, kRegistry, L"MsiUpgradeCode"), kMsiUpgrade) ||
                !EqualText(ReadString(HKEY_CURRENT_USER, kRegistry, L"BundleUpgradeCode"), kBundleUpgrade)) return false;
            // Old trials can retain another version's custom registration. The
            // official current-user MSI database, not that pointer, owns removal.
            auto pointer = ReadString(HKEY_CURRENT_USER, kRegistry, L"MsiProductCode");
            if (!CanonicalGuid(pointer) || (!EqualText(pointer, current_.product) && MsiPresent(pointer, sid_))) return false;
            current_.root = registered_; oldRoot_ = registered_;
        }
        identityValid_ = true; return true;
    }
    bool NewerProduct() const {
        int comparison = 0;
        return hasCurrent_ && (FAILED(m_pEngine->CompareVersions(current_.version.c_str(), candidate_.version.c_str(), &comparison)) || comparison > 0);
    }
    bool BundleIdentity(const std::wstring& code, const std::wstring& version, Ghost& ghost, bool orphan) const {
        if (!identityValid_ || !CanonicalGuid(code) || KnownProductCode(version).empty()) return false;
        auto key = std::wstring(kUninstallRegistry) + code;
        auto cache = ReadString(HKEY_CURRENT_USER, key.c_str(), L"BundleCachePath");
        auto local = KnownFolder(FOLDERID_LocalAppData);
        auto canonical = local + L"\\Package Cache\\" + code + L"\\dmelopers-block-pet_" + version + L"_x64-setup.exe";
        auto legacy = local + L"\\Package Cache\\" + code + L"\\dmelopers-block-pet-wixlocal_" + version + L"_x64-setup.exe";
        DWORD scope = 0, installed = 0, size = sizeof(DWORD);
        if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), L"BundleScope", RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &scope, &size) != ERROR_SUCCESS || scope != 2) return false;
        size = sizeof(DWORD);
        if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), L"Installed", RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &installed, &size) != ERROR_SUCCESS || installed != 1) return false;
        if (!ProductName(ReadString(HKEY_CURRENT_USER, key.c_str(), L"DisplayName")) || ReadString(HKEY_CURRENT_USER, key.c_str(), L"Publisher") != L"DMeloper" ||
            !EqualText(ReadString(HKEY_CURRENT_USER, key.c_str(), L"BundleProviderKey"), code) || ReadString(HKEY_CURRENT_USER, key.c_str(), L"DisplayVersion") != version ||
            (!EqualPath(cache, canonical) && !EqualPath(cache, legacy)) || !LocalPath(cache)) return false;
        DWORD bytes = 0;
        if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), L"BundleUpgradeCode", RRF_RT_REG_SZ | RRF_RT_REG_MULTI_SZ | RRF_SUBKEY_WOW6464KEY, nullptr, nullptr, &bytes) != ERROR_SUCCESS || bytes > 65536) return false;
        std::vector<wchar_t> upgrades(bytes / sizeof(wchar_t) + 2);
        if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), L"BundleUpgradeCode", RRF_RT_REG_SZ | RRF_RT_REG_MULTI_SZ | RRF_SUBKEY_WOW6464KEY, nullptr, upgrades.data(), &bytes) != ERROR_SUCCESS ||
            !EqualText(upgrades.data(), kBundleUpgrade) || upgrades[wcslen(upgrades.data()) + 1]) return false;
        DWORD attributes = GetFileAttributesW(cache.c_str());
        if (orphan) {
            if (attributes != INVALID_FILE_ATTRIBUTES || (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND)) return false;
        } else if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || FileHash(cache).empty()) return false;
        ghost = { code, version, cache, KnownProductCode(version) + L"_v" + version, ReadString(HKEY_CURRENT_USER, key.c_str(), L"DisplayName") }; return true;
    }
    bool IsGhost(const std::wstring& code) const {
        return std::any_of(ghosts_.begin(), ghosts_.end(), [&](const Ghost& ghost) { return EqualText(ghost.code, code); });
    }
    bool VerifiedGhost(const Ghost& ghost) const {
        Ghost checked;
        bool unchanged = BundleIdentity(ghost.code, ghost.version, checked, true) && checked.version == ghost.version &&
            EqualPath(checked.cache, ghost.cache) && checked.provider == ghost.provider && checked.displayName == ghost.displayName;
        auto product = KnownProductCode(ghost.version); ProductIdentity installed;
        bool protectedCandidate = newInstalled_ && EqualText(product, candidate_.product) && ghost.version == candidate_.version &&
            ReadOwnedProduct(candidate_.product, sid_, installed) && EqualText(installed.package, candidate_.package);
        return GhostEvidenceAccepted(unchanged, ProductAbsentEverywhere(product, sid_), protectedCandidate,
            EqualText(ghost.code, EngineString(L"WixBundleProviderKey")));
    }
    bool PendingGhostsValid() {
        for (auto item = ghosts_.begin(); item != ghosts_.end();) {
            HKEY key = nullptr;
            LSTATUS status = RegOpenKeyExW(HKEY_CURRENT_USER, (std::wstring(kUninstallRegistry) + item->code).c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &key);
            if (key) RegCloseKey(key);
            if (status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND) { item = ghosts_.erase(item); continue; }
            if (status != ERROR_SUCCESS || !VerifiedGhost(*item)) return false;
            ++item;
        }
        return true;
    }
    bool DependentsSafe(const ProductIdentity& product, bool& force) {
        force = false; DEPENDENCY* dependents = nullptr; UINT count = 0;
        auto provider = product.product + L"_v" + product.version;
        HRESULT hr = DepCheckDependents(HKEY_CURRENT_USER, provider.c_str(), 0, nullptr, &dependents, &count);
        if (hr == E_NOTFOUND || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) || hr == HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND)) return true;
        if (FAILED(hr)) return false;
        auto self = EngineString(L"WixBundleProviderKey"); bool safe = true;
        for (UINT i = 0; i < count; ++i) {
            if (EqualText(dependents[i].sczKey ? dependents[i].sczKey : L"", self)) continue;
            auto code = std::wstring(dependents[i].sczKey ? dependents[i].sczKey : L"");
            auto ghost = std::find_if(ghosts_.begin(), ghosts_.end(), [&](const Ghost& item) { return EqualText(item.code, code); });
            if (ghost != ghosts_.end()) {
                if (!VerifiedGhost(*ghost)) { safe = false; break; }
            } else {
                Ghost bundle;
                auto key = std::wstring(kUninstallRegistry) + code;
                auto version = ReadString(HKEY_CURRENT_USER, key.c_str(), L"DisplayVersion");
                if (version != product.version || !BundleIdentity(code, version, bundle, false)) { safe = false; break; }
                bundle.provider = provider;
                if (!std::any_of(oldBundles_.begin(), oldBundles_.end(), [&](const Ghost& item) { return EqualText(item.code, code); })) oldBundles_.push_back(bundle);
            }
            force = true;
        }
        ReleaseDependencyArray(dependents, count); return safe;
    }
    bool RetireOldBundles() {
        // Same-version bundles share ProductCode. Do not run their MSI remover
        // against the replacement. Retire verified metadata and retain cache bytes.
        if (remove_ && !ProductAbsentEverywhere(oldProduct_.product, sid_)) return false;
        for (const auto& old : oldBundles_) {
            Ghost checked;
            if (!BundleIdentity(old.code, old.version, checked, false) || !EqualPath(checked.cache, old.cache) || checked.displayName != old.displayName) {
                HKEY key = nullptr;
                LSTATUS status = RegOpenKeyExW(HKEY_CURRENT_USER, (std::wstring(kUninstallRegistry) + old.code).c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &key);
                if (key) RegCloseKey(key);
                if (status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND) continue;
                return false;
            }
            DEPENDENCY* dependents = nullptr; UINT count = 0;
            HRESULT hr = DepCheckDependents(HKEY_CURRENT_USER, old.code.c_str(), 0, nullptr, &dependents, &count);
            bool safe = hr == E_NOTFOUND || SUCCEEDED(hr);
            for (UINT i = 0; safe && i < count; ++i) safe = EqualText(dependents[i].sczKey ? dependents[i].sczKey : L"", old.code);
            ReleaseDependencyArray(dependents, count);
            if (!safe) return false;
            auto provider = old.provider;
            if (provider.empty()) return false;
            hr = DepUnregisterDependent(HKEY_CURRENT_USER, provider.c_str(), old.code.c_str());
            if (FAILED(hr) && hr != E_NOTFOUND && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return false;
            hr = DepUnregisterDependent(HKEY_CURRENT_USER, old.code.c_str(), old.code.c_str());
            if (FAILED(hr) && hr != E_NOTFOUND && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return false;
            hr = DepUnregisterDependency(HKEY_CURRENT_USER, old.code.c_str());
            if (FAILED(hr) && hr != E_NOTFOUND && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return false;
            HKEY key = nullptr;
            if (RegOpenKeyExW(HKEY_CURRENT_USER, kUninstallRegistry, 0, KEY_WRITE | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS) return false;
            LSTATUS removed = RegDeleteTreeW(key, old.code.c_str()); RegCloseKey(key);
            if (removed != ERROR_SUCCESS && removed != ERROR_FILE_NOT_FOUND) return false;
        }
        oldBundles_.clear(); return true;
    }
    bool RetireGhostBundles() {
        auto self = EngineString(L"WixBundleProviderKey");
        for (const auto& ghost : ghosts_) {
            auto product = KnownProductCode(ghost.version);
            if (product.empty() || EqualText(ghost.code, self) || !VerifiedGhost(ghost)) return false;
            bool absent = ProductAbsentEverywhere(product, sid_);
            ProductIdentity installed;
            bool replacement = newInstalled_ && EqualText(product, candidate_.product) && ghost.version == candidate_.version &&
                ReadOwnedProduct(candidate_.product, sid_, installed) && EqualText(installed.package, candidate_.package);
            if (!absent && !replacement) return false;
            for (const auto& provider : { ghost.code, ghost.provider }) {
                DEPENDENCY* dependents = nullptr; UINT count = 0;
                HRESULT hr = DepCheckDependents(HKEY_CURRENT_USER, provider.c_str(), 0, nullptr, &dependents, &count);
                bool safe = hr == E_NOTFOUND || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) || SUCCEEDED(hr);
                for (UINT i = 0; safe && i < count; ++i) {
                    std::wstring code = dependents[i].sczKey ? dependents[i].sczKey : L"";
                    safe = EqualText(code, ghost.code) || (provider == ghost.provider &&
                        ((replacement && EqualText(code, self)) || std::any_of(ghosts_.begin(), ghosts_.end(), [&](const Ghost& other) { return other.provider == ghost.provider && EqualText(code, other.code) && VerifiedGhost(other); })));
                }
                ReleaseDependencyArray(dependents, count); if (!safe) return false;
            }
            HRESULT hr = DepUnregisterDependent(HKEY_CURRENT_USER, ghost.provider.c_str(), ghost.code.c_str());
            if (FAILED(hr) && hr != E_NOTFOUND && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return false;
            hr = DepUnregisterDependent(HKEY_CURRENT_USER, ghost.code.c_str(), ghost.code.c_str());
            if (FAILED(hr) && hr != E_NOTFOUND && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return false;
            hr = DepUnregisterDependency(HKEY_CURRENT_USER, ghost.code.c_str());
            if (FAILED(hr) && hr != E_NOTFOUND && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return false;
            if (absent) {
                DEPENDENCY* dependents = nullptr; UINT count = 0;
                hr = DepCheckDependents(HKEY_CURRENT_USER, ghost.provider.c_str(), 0, nullptr, &dependents, &count);
                bool empty = hr == E_NOTFOUND || (SUCCEEDED(hr) && count == 0); ReleaseDependencyArray(dependents, count);
                if (empty) {
                    hr = DepUnregisterDependency(HKEY_CURRENT_USER, ghost.provider.c_str());
                    if (FAILED(hr) && hr != E_NOTFOUND && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return false;
                }
            }
            HKEY key = nullptr;
            if (RegOpenKeyExW(HKEY_CURRENT_USER, kUninstallRegistry, 0, KEY_WRITE | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS) return false;
            LSTATUS removed = RegDeleteTreeW(key, ghost.code.c_str()); RegCloseKey(key);
            if (removed != ERROR_SUCCESS && removed != ERROR_FILE_NOT_FOUND) return false;
        }
        ghosts_.clear(); return true;
    }
    bool CandidateCached() const {
        auto path = KnownFolder(FOLDERID_LocalAppData) + L"\\Package Cache\\" + candidate_.product + L"v" + candidate_.version + L"\\application.msi";
        ProductIdentity actual;
        return FileHash(path) == candidateSha_ && MsiIdentity(path, actual) && EqualText(actual.product, candidate_.product) &&
            EqualText(actual.package, candidate_.package) && actual.version == candidate_.version;
    }
    bool TargetReady() {
        ULONGLONG available = 0;
        if (!LocalPath(directory_) || !AvailableSpace(directory_, available) || available < installedSize_) return false;
        DWORD attributes = GetFileAttributesW(Exe().c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES && (!hasCurrent_ || !EqualPath(directory_, current_.root) || (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))) return false;
        if (!hasCurrent_ || !EqualPath(directory_, current_.root)) {
            for (const wchar_t* member : { kExe, L"assets\\tray.png", L"assets\\models\\dmeloper\\dmeloper.glb", L"assets\\models\\dmeloper\\default.png",
                    L"THIRD-PARTY-NOTICES.txt", L"dependencies.cdx.json", L"ThirdParty-WiX.txt", L"uninstall.exe" }) {
                auto file = directory_ + L"\\" + member;
                if (!LocalPath(file) || GetFileAttributesW(file.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
                if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) return false;
            }
        }
        int created = SHCreateDirectoryExW(window_, directory_.c_str(), nullptr);
        if (created != ERROR_SUCCESS && created != ERROR_ALREADY_EXISTS && created != ERROR_FILE_EXISTS) return false;
        wchar_t temporary[MAX_PATH]{};
        if (!GetTempFileNameW(directory_.c_str(), L"bpt", 0, temporary)) return false;
        return DeleteFileW(temporary) != FALSE;
    }
    void CaptureOwnedRun(const std::wstring& app, bool replacing) {
        constexpr wchar_t runKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        for (const wchar_t* name : { kProduct, L"DMeloper's Block Pet WiX Local", L"DMeloper's Block Pet (Independent)" }) {
            auto launch = ReadString(HKEY_CURRENT_USER, runKey, name);
            if (!OwnedRunValue(launch, app)) continue;
            if (replacing && oldRun_.empty()) { oldRun_ = launch; oldRunName_ = name; }
            HKEY key = nullptr;
            if (RegOpenKeyExW(HKEY_CURRENT_USER, runKey, 0, KEY_SET_VALUE | KEY_WOW64_64KEY, &key) == ERROR_SUCCESS) { RegDeleteValueW(key, name); RegCloseKey(key); }
        }
    }
    void CleanupOwned(const std::wstring& root, bool replacing) {
        auto app = root + L"\\" + kExe;
        Shortcut(KnownFolder(FOLDERID_Desktop), app, L"Desktop", true);
        Shortcut(KnownFolder(FOLDERID_Programs), app, L"StartMenu", true);
        RemoveOwnedFile(root + L"\\" + kRemovalLink, ReadString(HKEY_CURRENT_USER, kReceipts, L"Uninstall"));
        CaptureOwnedRun(app, replacing);
        if (!replacing) RegDeleteKeyExW(HKEY_CURRENT_USER, kReceipts, KEY_WOW64_64KEY, 0);
        for (const wchar_t* child : { L"\\assets\\models\\dmeloper", L"\\assets\\models", L"\\assets", L"" }) RemoveDirectoryW((root + child).c_str());
    }
    void RestoreOwnedRun() {
        if (oldRun_.empty()) return;
        constexpr wchar_t runKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        std::wstring name = kProduct;
        auto existing = ReadString(HKEY_CURRENT_USER, runKey, kProduct);
        if (!existing.empty()) {
            if (OwnedRunValue(existing, Exe())) { oldRun_.clear(); oldRunName_.clear(); return; }
            // Preserve a foreign current-name entry. A previously owned legacy
            // name can keep autostart enabled without overwriting that entry.
            name = oldRunName_;
            if (name.empty() || name == kProduct || !ReadString(HKEY_CURRENT_USER, runKey, name.c_str()).empty()) return;
        }
        HKEY key = nullptr;
        if (RegCreateKeyExW(HKEY_CURRENT_USER, runKey, 0, nullptr, 0, KEY_SET_VALUE | KEY_WOW64_64KEY, nullptr, &key, nullptr) == ERROR_SUCCESS) {
            auto command = Quote(Exe()); RegSetValueExW(key, name.c_str(), 0, REG_SZ, reinterpret_cast<const BYTE*>(command.c_str()), static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t))); RegCloseKey(key);
        }
        oldRun_.clear(); oldRunName_.clear();
    }
    HWND Control(const wchar_t* cls, const wchar_t* title, DWORD style, int x, int y, int w, int h, int id = 0) {
        HWND control = CreateWindowExW(0, cls, title, WS_CHILD | style, MulDiv(x, dpi_, 96), MulDiv(y, dpi_, 96), MulDiv(w, dpi_, 96), MulDiv(h, dpi_, 96), window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), instance_, nullptr);
        SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(font_), TRUE); return control;
    }
    bool SidebarPage() const { return (page_ == 0 && !remove_) || page_ == 4; }
    void Place(HWND control, int x, int y, int width, int height) {
        SetWindowPos(control, nullptr, MulDiv(x, dpi_, 96), MulDiv(y, dpi_, 96), MulDiv(width, dpi_, 96), MulDiv(height, dpi_, 96), SWP_NOZORDER | SWP_NOACTIVATE);
    }
    void PaintChrome(HDC dc) {
        RECT bounds{ 0, 0, MulDiv(kUiWidth, dpi_, 96), MulDiv(kUiHeight, dpi_, 96) };
        FillRect(dc, &bounds, GetSysColorBrush(COLOR_BTNFACE));
        RECT header{ 0, 0, bounds.right, MulDiv(SidebarPage() ? kFooterTop : kHeaderBottom, dpi_, 96) };
        FillRect(dc, &header, GetSysColorBrush(COLOR_WINDOW));
        HICON icon = artworkIcon_;
        if (SidebarPage()) {
            // The classic MUI welcome/finish silhouette, using the product's
            // own icon rather than an unrelated stock installer illustration.
            int width = MulDiv(kSidebarWidth, dpi_, 96), height = MulDiv(kFooterTop, dpi_, 96);
            for (int y = 0; y < height; ++y) {
                int shade = height ? y * 28 / height : 0;
                HBRUSH brush = CreateSolidBrush(RGB(25 + shade / 2, 66 + shade, 120 + shade));
                RECT stripe{ 0, y, width, y + 1 }; FillRect(dc, &stripe, brush); DeleteObject(brush);
            }
            int size = MulDiv(88, dpi_, 96);
            if (icon) DrawIconEx(dc, (width - size) / 2, MulDiv(68, dpi_, 96), icon, size, size, 0, nullptr, DI_NORMAL);
            HFONT old = static_cast<HFONT>(SelectObject(dc, titleFont_));
            SetBkMode(dc, TRANSPARENT); SetTextColor(dc, RGB(255, 255, 255));
            RECT label{ MulDiv(16, dpi_, 96), MulDiv(176, dpi_, 96), width - MulDiv(16, dpi_, 96), MulDiv(250, dpi_, 96) };
            DrawTextW(dc, L"DMeloper's\nBlock Pet", -1, &label, DT_CENTER | DT_WORDBREAK | DT_NOPREFIX);
            SelectObject(dc, old);
        } else {
            int size = MulDiv(36, dpi_, 96);
            if (icon) DrawIconEx(dc, MulDiv(504, dpi_, 96), MulDiv(18, dpi_, 96), icon, size, size, 0, nullptr, DI_NORMAL);
            RECT line{ 0, MulDiv(kHeaderBottom, dpi_, 96), bounds.right, MulDiv(kHeaderBottom + 2, dpi_, 96) };
            DrawEdge(dc, &line, EDGE_ETCHED, BF_TOP);
        }
        RECT footer{ 0, MulDiv(kFooterTop, dpi_, 96), bounds.right, MulDiv(kFooterTop + 2, dpi_, 96) };
        DrawEdge(dc, &footer, EDGE_ETCHED, BF_TOP);
    }
    void UpdateDiskSpace() {
        if (page_ != 1 || remove_ || !edit_ || !space_) return;
        std::vector<wchar_t> input(32768); GetWindowTextW(edit_, input.data(), static_cast<int>(input.size()));
        ULONGLONG available = 0;
        bool known = AvailableSpace(input.data(), available);
        SetWindowTextW(space_, SpaceSummary(installedSize_, known, available, korean_).c_str());
    }
    void ShowPage(int page) {
        page_ = page;
        for (HWND item : { edit_, browse_, desktopBox_, startBox_, runBox_, deleteBox_, progress_, group_, details_, space_, path_ }) ShowWindow(item, SW_HIDE);
        ShowWindow(back_, automatic_ ? SW_HIDE : SW_SHOW);
        EnableWindow(back_, page > 0 && page < 3);
        EnableWindow(cancel_, !finished_ && !CheckCanceled());
        EnableWindow(next_, !active_ && !detecting_);
        ShowWindow(next_, automatic_ ? SW_HIDE : SW_SHOW);
        SetWindowTextW(next_, T(L"다음(&N) >", L"&Next >"));
        SendMessageW(heading_, WM_SETFONT, reinterpret_cast<WPARAM>(SidebarPage() ? welcomeFont_ : titleFont_), TRUE);
        Place(heading_, SidebarPage() ? 188 : 24, SidebarPage() ? 28 : 14, SidebarPage() ? 348 : 466, SidebarPage() ? 76 : 25);
        Place(text_, SidebarPage() ? 188 : 24, SidebarPage() ? 118 : 96, SidebarPage() ? 348 : 512, SidebarPage() ? 178 : 96);
        ShowWindow(subtitle_, SidebarPage() ? SW_HIDE : SW_SHOW);
        if (page == 0) {
            SetWindowTextW(heading_, remove_ ? T(L"사용자 데이터", L"User data") : T(L"DMeloper's Block Pet 설치", L"Welcome to DMeloper's Block Pet"));
            SetWindowTextW(subtitle_, T(L"개인 설정과 파일을 유지할지 삭제할지 선택하세요.", L"Choose whether to keep or remove your personal settings and files."));
            SetWindowTextW(text_, remove_ ? T(L"기본 제거에서는 설정·프리셋·스킨을 유지합니다.", L"By default, settings, presets and skins are kept after uninstalling.") : T(L"이 마법사는 현재 Windows 계정에 DMeloper's Block Pet을 설치합니다.\r\n\r\n계속하려면 다음을 누르세요.", L"This wizard installs DMeloper's Block Pet for your Windows account.\r\n\r\nSelect Next to continue."));
            if (remove_) {
                Place(text_, 24, 96, 512, 52); Place(group_, 24, 160, 512, 162);
                SetWindowTextW(group_, T(L"개인 설정 및 파일", L"Personal settings and files")); ShowWindow(group_, SW_SHOW);
                Place(deleteBox_, 40, 188, 476, 30); ShowWindow(deleteBox_, SW_SHOW);
                Place(details_, 40, 230, 476, 72);
#if defined(BP_OFFICIAL_BUILD)
                SetWindowTextW(details_, T(L"선택하면 Saved Games의 공유 설정·프리셋·스킨과 GitHub판 개인 데이터를 모두 삭제합니다. Store판에서도 공유 데이터가 삭제됩니다.", L"Selecting this option removes shared Saved Games settings, presets and skins, plus GitHub personal data. The Store app also loses the shared data.")); ShowWindow(details_, SW_SHOW);
#else
                SetWindowTextW(details_, T(L"선택하면 이 설치의 설정·프리셋·스킨 등 사용자 데이터를 모두 삭제합니다. 다른 설치의 데이터에는 영향을 주지 않습니다.", L"Selecting this option removes this installation's settings, presets and skins. Other installations' data is kept.")); ShowWindow(details_, SW_SHOW);
#endif
            }
        } else if (page == 1) {
            SetWindowTextW(heading_, remove_ ? T(L"제거 확인", L"Confirm uninstall") : T(L"설치 위치", L"Choose install location"));
            SetWindowTextW(subtitle_, remove_ ? T(L"제거를 누르면 앱 파일을 제거합니다.", L"Select Uninstall to remove the app files.") : T(L"DMeloper's Block Pet을 설치할 폴더를 선택하세요.", L"Choose a folder for DMeloper's Block Pet."));
            SetWindowTextW(text_, remove_ ? T(L"앱 파일을 제거합니다. 별도 데이터 삭제 옵션을 선택하지 않으면 사용자 데이터는 유지됩니다.", L"The app files will be removed. User data is kept unless you select the separate removal option.") : T(L"설치 전에 앱을 종료하세요. 같은 폴더에 재설치하면 설정·프리셋·스킨을 유지합니다.\r\n앱에서 업데이트를 설치할 수 있습니다. 설치 중단 후 복구는 수동으로 진행합니다.", L"Close the app before installing. Reinstall to the same folder to keep settings, presets and skins. Updates can also be installed from the app. Repair after an interrupted installation is manual."));
            Place(group_, 24, 208, 512, 114); ShowWindow(group_, SW_SHOW);
            if (remove_) {
                SetWindowTextW(next_, T(L"제거(&U)", L"&Uninstall")); SetWindowTextW(group_, T(L"제거할 항목", L"Uninstall summary"));
                Place(path_, 40, 236, 476, 24); SetWindowTextW(path_, directory_.c_str()); ShowWindow(path_, SW_SHOW);
                Place(details_, 40, 278, 476, 28);
                SetWindowTextW(details_, deleteData_ ? T(L"사용자 데이터: 모두 삭제", L"User data: remove all") : T(L"사용자 데이터: 유지", L"User data: keep")); ShowWindow(details_, SW_SHOW);
            } else {
                Place(group_, 24, 208, 512, hasCurrent_ ? 100 : 68);
                SetWindowTextW(group_, T(L"설치할 폴더", L"Destination folder"));
                Place(edit_, 40, 236, 374, 24); Place(browse_, 424, 235, 96, 26);
                SetWindowTextW(edit_, directory_.c_str()); ShowWindow(edit_, SW_SHOW); EnableWindow(edit_, TRUE); ShowWindow(browse_, SW_SHOW);
                if (hasCurrent_) {
                    Place(details_, 40, 276, 476, 20);
                    SetWindowTextW(details_, T(L"폴더를 변경해도 개인 데이터는 유지됩니다.", L"Changing the folder keeps your personal data.")); ShowWindow(details_, SW_SHOW);
                }
                Place(space_, 24, hasCurrent_ ? 316 : 284, 512, 34); UpdateDiskSpace(); ShowWindow(space_, SW_SHOW);
            }
        } else if (page == 2) {
            SetWindowTextW(heading_, T(L"바로가기 선택", L"Choose shortcuts"));
            SetWindowTextW(subtitle_, T(L"설치할 바로가기를 선택하세요.", L"Choose which shortcuts to install."));
            SetWindowTextW(text_, T(L"바탕화면과 시작 메뉴 바로가기를 만들지 선택하세요.", L"Choose whether to create desktop and Start menu shortcuts.")); Place(text_, 24, 96, 512, 42);
            Place(group_, 24, 152, 512, 122); SetWindowTextW(group_, T(L"바로가기", L"Shortcuts")); ShowWindow(group_, SW_SHOW);
            ShowWindow(desktopBox_, SW_SHOW); ShowWindow(startBox_, SW_SHOW);
            Place(details_, 24, 292, 512, 42); SetWindowTextW(details_, T(L"같은 이름의 기존 바로가기는 덮어쓰지 않습니다.", L"Existing shortcuts with the same name are preserved.")); ShowWindow(details_, SW_SHOW);
            SetWindowTextW(next_, T(L"설치(&I)", L"&Install"));
        } else if (page == 3) {
            SetWindowTextW(heading_, remove_ ? T(L"제거 중", L"Uninstalling") : T(L"설치 중", L"Installing"));
            SetWindowTextW(subtitle_, T(L"작업이 완료될 때까지 기다려 주세요.", L"Please wait while setup completes."));
            SetWindowTextW(text_, T(L"작업을 진행하고 있습니다. 잠시 기다려 주세요.", L"Setup is working. Please wait."));
            Place(text_, 24, 96, 512, 42);
            ShowWindow(progress_, SW_SHOW);
            Place(group_, 24, 204, 512, 118); SetWindowTextW(group_, T(L"설치 위치", L"Install location")); ShowWindow(group_, SW_SHOW);
            Place(path_, 40, 236, 476, 24); SetWindowTextW(path_, directory_.c_str()); ShowWindow(path_, SW_SHOW);
        } else {
            SetWindowTextW(heading_, failed_ ? T(L"작업을 완료하지 못했습니다", L"Setup could not complete") : remove_ ? T(L"제거 완료", L"Uninstall complete") : T(L"설치 완료", L"Installation complete"));
            Place(text_, 188, 118, 348, 114);
            SetWindowTextW(text_, failed_ ? T(L"앱을 종료하고 같은 폴더에서 설치 파일을 다시 실행하세요. 기존 설정은 유지됩니다.", L"Close the app and run setup again in the same folder. Existing settings are preserved.") : remove_ ? T(L"앱 파일을 제거했습니다.\r\n\r\n마침을 눌러 제거 프로그램을 닫으세요.", L"The app files have been removed.\r\n\r\nSelect Finish to close this wizard.") : T(L"설치를 마쳤습니다. 앱 실행 여부를 선택한 뒤 마침을 눌러 설치 프로그램을 닫으세요.", L"Installation is complete. Choose whether to run the app, then select Finish to close this wizard."));
            if (!failed_ && !remove_) ShowWindow(runBox_, SW_SHOW);
            SetWindowTextW(next_, T(L"마침(&F)", L"&Finish")); EnableWindow(cancel_, FALSE);
        }
        // Group boxes are transparent. Repaint the parent's background under
        // their full bounds, then repaint children after every page transition.
        RedrawWindow(window_, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW);
        if (!Unattended()) {
            HWND focus = active_ ? window_ : remove_ && page == 0 ? deleteBox_ : page == 1 && !remove_ ? edit_ : page == 2 ? desktopBox_ : next_;
            if (IsWindowEnabled(focus)) SetFocus(focus);
        }
    }
    bool ParseCommand() {
        int count = 0;
        LPWSTR* args = CommandLineToArgvW((L"BlockPetBA " + rawCommand_).c_str(), &count);
        if (!args) return false;
        bool ok = true; std::wstring requested;
        for (int i = 1; i < count; ++i) {
            std::wstring arg(args[i]);
            if (arg == L"--bp-update") update_ = true;
            else if (arg == L"--bp-restart") restart_ = true;
            else if (arg == L"--bp-delete-user-data") {
                if (deleteData_ || !remove_ || related_) { ok = false; break; }
                deleteData_ = true;
            }
            else if (arg == L"--bp-attempt") {
                if (++i >= count || !attempt_.empty()) { ok = false; break; }
                attempt_ = args[i];
                if (attempt_.size() != 32 || attempt_.find_first_not_of(L"0123456789abcdef") != std::wstring::npos) { ok = false; break; }
            }
            else if (arg == L"--bp-parent-pid" || arg == L"--bp-parent-created" || arg == L"--bp-install-dir") {
                if (++i >= count) { ok = false; break; }
                if (arg == L"--bp-install-dir") requested = args[i];
                else {
                    wchar_t* end = nullptr; ULONGLONG value = _wcstoui64(args[i], &end, 10);
                    if (!value || !end || *end) { ok = false; break; }
                    if (arg == L"--bp-parent-pid") { if (value > MAXDWORD) { ok = false; break; } parentPid_ = static_cast<DWORD>(value); }
                    else parentCreated_ = value;
                }
            } else if (arg.rfind(L"--bp-", 0) == 0) { ok = false; break; }
        }
        LocalFree(args);
        if (update_) ok = ok && !remove_ && parentPid_ && parentCreated_ && !attempt_.empty() && !registered_.empty() && EqualPath(requested, registered_) && ReadString(HKEY_CURRENT_USER, kRegistry, L"DeliveryMode") == kDeliveryMode;
        else ok = ok && !parentPid_ && !parentCreated_ && requested.empty() && !restart_ && attempt_.empty();
        return ok;
    }
    bool WaitParent() {
        HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentPid_);
        if (!parent) return false;
        FILETIME created{}, exited{}, kernel{}, user{};
        bool ok = GetProcessTimes(parent, &created, &exited, &kernel, &user) &&
            ((static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime) == parentCreated_ &&
            SameSid(parent) && EqualPath(ProcessPath(parent), Exe());
        if (ok) {
            auto name = std::wstring(kUpdateReady) + std::to_wstring(parentPid_) + L"." + std::to_wstring(parentCreated_) + L"." + attempt_;
            auto commitName = std::wstring(kUpdateCommit) + std::to_wstring(parentPid_) + L"." + std::to_wstring(parentCreated_) + L"." + attempt_;
            HANDLE ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, name.c_str());
            HANDLE commit = OpenEventW(SYNCHRONIZE, FALSE, commitName.c_str());
            ok = ready && commit && SetEvent(ready);
            if (ok) ok = WaitForSingleObject(commit, 15000) == WAIT_OBJECT_0;
            if (ready) CloseHandle(ready);
            if (commit) CloseHandle(commit);
        }
        if (ok) ok = WaitForSingleObject(parent, 15000) == WAIT_OBJECT_0;
        CloseHandle(parent); return ok;
    }
    bool RequireWebView() {
        const auto guide = WebViewGuide(korean_);
        if (!WebViewAvailable()) {
            auto message = std::wstring(T(L"3D 렌더링을 위해 Microsoft WebView2 Runtime 프로그램이 필요합니다. ", L"Microsoft WebView2 Runtime is needed for 3D rendering. "));
            auto closing = T(L" 에서 수동으로 설치한 뒤 다시 실행해 주세요.", L" to install it manually, then try again.");
            auto plain = message + guide + closing;
            if (Unattended()) Error(plain);
            else {
                auto content = message + L"<a href=\"" + guide + L"\">" + T(L"다음 링크", L"Follow this link") + L"</a>" + closing;
                TASKDIALOGCONFIG dialog{ sizeof(dialog) };
                dialog.hwndParent = window_; dialog.dwFlags = TDF_ENABLE_HYPERLINKS | TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT;
                dialog.dwCommonButtons = TDCBF_OK_BUTTON; dialog.pszWindowTitle = kDisplayProduct;
                dialog.pszMainIcon = TD_ERROR_ICON; dialog.pszContent = content.c_str(); dialog.pfCallback = WebViewGuideCallback;
                dialog.lpCallbackData = reinterpret_cast<LONG_PTR>(guide);
                if (FAILED(TaskDialogIndirect(&dialog, nullptr, nullptr, nullptr))) Error(plain);
            }
            return false;
        }
        return true;
    }
    bool Prerequisites() {
        DWORD build = wcstoul(ReadString(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", L"CurrentBuildNumber").c_str(), nullptr, 10);
        SYSTEM_INFO system{}; GetNativeSystemInfo(&system);
        DWORD revision = 0; bool revisionKnown = ReadWindowsRevision(revision);
        if (!MinimumPlatform(build, revision, revisionKnown, system.wProcessorArchitecture))
            Warning(T(L"최소 사양은 Windows 10 22H2(빌드 19045.3448) 또는 Windows 11 22H2(빌드 22621.2283) 이상의 x64 환경입니다. 2023년 9월 또는 이후 누적 업데이트가 필요합니다. 현재 Windows가 최소 사양에 미달하거나 업데이트 상태를 확인할 수 없습니다. 계속 설치할 수 있지만 일부 기능이 올바르게 작동하지 않을 수 있습니다.", L"The minimum requirements are Windows 10 22H2 (build 19045.3448) or Windows 11 22H2 (build 22621.2283) or later, x64, with the September 2023 or a later cumulative update. Your Windows version is below these requirements, or its update status could not be checked. Installation can continue, but some features may not work correctly."));
        return managedWebView_ || RequireWebView();
    }
    bool CleanupData() {
        std::wstring command = Quote(Exe()) + L" --dmeloper-uninstall-delete-user-data";
        STARTUPINFOW startup{ sizeof(startup) }; PROCESS_INFORMATION process{};
        if (!CreateProcessW(Exe().c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, directory_.c_str(), &startup, &process)) { Error(T(L"데이터 정리가 알 수 없는 이유로 시작되지 않아 제거되지 않았습니다. 컴퓨터를 재부팅 후 다시 시도해주세요.", L"Data cleanup could not start for an unknown reason, so the app was not uninstalled. Restart your computer and try again.")); return false; }
        CloseHandle(process.hThread);
        DWORD result = 1; if (WaitForSingleObject(process.hProcess, 60000) == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &result);
        CloseHandle(process.hProcess);
        if (result) {
            Error(result == 20 ? T(L"프로그램이 실행 중입니다. 종료 후 다시 제거를 시도해주세요. 데이터는 삭제되지 않았습니다.", L"The program is running. Close it and try again. No data was deleted.") : result == 22 ? T(L"데이터 삭제 요청을 확인할 수 없습니다. 제거 프로그램을 다시 실행해 재시도하세요.", L"The data removal request could not be verified. Run the uninstaller again.") : T(L"선택한 데이터를 안전하게 삭제하지 못했습니다. 일부 파일은 이미 삭제되었을 수 있으며 앱 자체는 제거하지 않았습니다.", L"Data could not be safely removed. Some files may already have been deleted; the app itself has not been uninstalled.")); return false;
        }
        return true;
    }
    bool RemovedProduct() const {
        return MsiAbsent(oldProduct_.product, sid_) && GetFileAttributesW(OldExe().c_str()) == INVALID_FILE_ATTRIBUTES &&
            (GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND);
    }
    void PlanStage(BOOTSTRAPPER_ACTION action) {
        plannedApplication_ = BOOTSTRAPPER_ACTION_STATE_NONE;
        HRESULT hr = m_pEngine->Plan(action, BOOTSTRAPPER_SCOPE_PER_USER);
        if (FAILED(hr)) Complete(hr);
    }
    bool RemovalPlanReady() const {
        return related_ || !((remove_ && phase_ == Phase::Normal) || phase_ == Phase::RemoveBurn) || plannedApplication_ == BOOTSTRAPPER_ACTION_STATE_UNINSTALL;
    }
    static bool ReplaceNeeded(const ProductIdentity& current, const ProductIdentity& candidate, const std::wstring& target) {
        return (EqualText(current.product, candidate.product) && !EqualText(current.package, candidate.package)) || !EqualPath(current.root, target);
    }
    bool SetInstallVariables(const std::wstring& folder) {
        HRESULT hr = m_pEngine->SetVariableString(L"InstallFolder", folder.c_str(), FALSE);
        if (SUCCEEDED(hr)) hr = m_pEngine->SetVariableNumeric(L"DesktopShortcut", desktop_ ? 1 : 0);
        if (SUCCEEDED(hr)) hr = m_pEngine->SetVariableNumeric(L"StartMenuShortcut", start_ ? 1 : 0);
        if (FAILED(hr)) { Complete(hr); return false; } return true;
    }
    static int WINAPI MsiRemovalUi(LPVOID context, UINT message, MSIHANDLE) {
        auto self = static_cast<BlockPetBootstrapper*>(context);
        UINT type = message & 0xFF000000;
        if (self->CheckCanceled() || type == INSTALLMESSAGE_FILESINUSE || type == INSTALLMESSAGE_RMFILESINUSE) return IDCANCEL;
        return IDOK;
    }
    static DWORD WINAPI RemoveMsiThread(LPVOID context) {
        auto self = static_cast<BlockPetBootstrapper*>(context); ProductIdentity current;
        UINT result = ERROR_INSTALL_FAILURE;
        bool safe = ReadOwnedProduct(self->current_.product, self->sid_, current) && EqualText(current.package, self->current_.package) &&
            current.version == self->current_.version && EqualPath(current.localPackage, self->current_.localPackage) && !RunningAt(self->OldExe()) && !RunningAt(self->Exe());
        bool force = false; safe = safe && self->DependentsSafe(current, force);
        if (safe && !self->CheckCanceled()) {
            INSTALLUILEVEL previous = MsiSetInternalUI(INSTALLUILEVEL_NONE, nullptr);
            INSTALLUI_HANDLER_RECORD prior = nullptr;
            UINT hooked = MsiSetExternalUIRecord(MsiRemovalUi, INSTALLLOGMODE_PROGRESS | INSTALLLOGMODE_FILESINUSE | INSTALLLOGMODE_RMFILESINUSE | INSTALLLOGMODE_ERROR | INSTALLLOGMODE_ACTIONSTART, self, &prior);
            if (hooked == ERROR_SUCCESS) {
                self->applyStarted_ = true;
                result = MsiConfigureProductExW(current.product.c_str(), INSTALLLEVEL_DEFAULT, INSTALLSTATE_ABSENT, L"REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=Disable");
                MsiSetExternalUIRecord(prior, 0, nullptr, nullptr);
            }
            MsiSetInternalUI(previous, nullptr);
        } else if (self->CheckCanceled()) result = ERROR_INSTALL_USEREXIT;
        PostMessageW(self->window_, kMsiRemoved, result, 0); return result;
    }
    void BeginOldRemoval() {
        if (!CandidateCached() || (managedWebView_ && !WebViewAvailable()) || !TargetReady() || !ProbeProducts() || !hasCurrent_ || NewerProduct() ||
            !EqualText(current_.product, oldProduct_.product) || !EqualText(current_.package, oldProduct_.package) || !EqualPath(current_.root, oldProduct_.root) ||
            RunningAt(OldExe()) || RunningAt(Exe()) || !DependentsSafe(current_, forceFamilyRemoval_)) {
            Complete(HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE)); return;
        }
        if (EqualText(current_.product, candidate_.product)) {
            phase_ = Phase::RemoveBurn;
            if (SetInstallVariables(oldRoot_)) PlanStage(BOOTSTRAPPER_ACTION_UNINSTALL);
        } else {
            phase_ = Phase::RemoveMsi; directRemoval_ = true;
            removalThread_ = CreateThread(nullptr, 0, RemoveMsiThread, this, 0, nullptr);
            if (!removalThread_) Complete(HRESULT_FROM_WIN32(GetLastError()));
        }
    }
    void OldRemovalComplete(HRESULT hr, bool restarted) {
        if (FAILED(hr)) { Complete(hr); return; }
        if (restarted) {
            rebootRequired_ = true;
            Error(T(L"기존 앱 제거 후 재부팅이 필요합니다. 재부팅한 다음 설치 프로그램을 다시 실행하세요. 개인 데이터는 유지됩니다.", L"Restart Windows after removing the previous app, then run setup again. Your personal data is retained."));
            Close(ERROR_SUCCESS_REBOOT_REQUIRED); return;
        }
        oldRemoved_ = MsiAbsent(oldProduct_.product, sid_);
        if (!RemovedProduct()) { Complete(HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE)); return; }
        oldRemoved_ = true; CleanupOwned(oldRoot_, true);
        directory_ = selectedRoot_; registered_.clear();
        phase_ = Phase::Redetect;
        if (SetInstallVariables(directory_)) BeginDetect();
    }
    bool StageComplete(HRESULT hr) {
        if (phase_ == Phase::Prepare) {
            if (SUCCEEDED(hr) && rebootRequired_) {
                Error(T(L"필요한 구성 요소 준비 후 Windows 재부팅이 필요합니다. 기존 앱과 개인 데이터는 유지됩니다. 재부팅 후 설치 프로그램을 다시 실행하세요.", L"Restart Windows to finish preparing the required component, then run setup again. The existing app and personal data are retained."));
                Close(ERROR_SUCCESS_REBOOT_REQUIRED); return true;
            }
            if (FAILED(hr) || !CandidateCached() || (managedWebView_ && !WebViewAvailable())) {
                if (SUCCEEDED(hr)) hr = HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE);
                Complete(hr); return true;
            }
            prepared_ = true; phase_ = Phase::ReadyToRemove; BeginDetect(); return true;
        }
        if (phase_ == Phase::RemoveBurn) { OldRemovalComplete(hr, rebootRequired_); return true; }
        return false;
    }
    void StartApply() {
        // Burn invokes the superseded bundle after the new MSI has upgraded it.
        // The new BA already holds the installation gate. Old bundle cleanup
        // must not compete for that gate or remove the new shortcut receipts.
        if (related_) {
            if (!remove_) { Close(ERROR_INVALID_PARAMETER); return; }
            active_ = true; ShowPage(3);
            HRESULT hr = m_pEngine->Plan(BOOTSTRAPPER_ACTION_UNINSTALL, BOOTSTRAPPER_SCOPE_PER_USER);
            if (FAILED(hr)) Complete(hr);
            return;
        }
        if (!identityValid_ || NewerProduct()) { Complete(HRESULT_FROM_WIN32(ERROR_PRODUCT_VERSION)); return; }
        if (!remove_ && !Prerequisites()) { if (automatic_) Close(ERROR_INSTALL_FAILURE); else Complete(HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE), false); return; }
        if (update_ && !WaitParent()) { Error(T(L"업데이트를 시작한 앱을 확인하거나 종료를 기다리지 못했습니다. 앱을 종료한 뒤 다시 시도하세요.", L"Could not verify or wait for the updating app. Close the app and try again.")); Close(ERROR_INVALID_PARAMETER); return; }
        mutex_ = CreateMutexW(nullptr, FALSE, kMutex);
        DWORD gateError = GetLastError();
        if (!mutex_ || gateError == ERROR_ALREADY_EXISTS) { if (mutex_) { CloseHandle(mutex_); mutex_ = nullptr; } Error(RunningAt(Exe()) ? T(L"프로그램이 실행 중입니다. 앱을 종료한 뒤 다시 시도 해주세요.", L"The program is running. Close the app and try again.") : T(L"다른 설치 작업이 진행 중입니다. 완료 후 다시 시도하세요.", L"Another setup is running. Try again after it finishes.")); if (automatic_) Close(ERROR_INSTALL_ALREADY_RUNNING); else Complete(HRESULT_FROM_WIN32(gateError == ERROR_ALREADY_EXISTS ? ERROR_INSTALL_ALREADY_RUNNING : gateError), false); return; }
        if (RunningAt(Exe()) || (hasCurrent_ && RunningAt(OldExe()))) { Error(T(L"프로그램이 실행 중입니다. 앱을 종료한 뒤 다시 시도 해주세요.", L"The program is running. Close the app and try again.")); CloseHandle(mutex_); mutex_ = nullptr; if (automatic_) Close(ERROR_SHARING_VIOLATION); else Complete(HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION), false); return; }
        if (remove_ && (!hasCurrent_ || !EqualText(current_.product, candidate_.product) || !DependentsSafe(current_, forceFamilyRemoval_))) { Complete(HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE)); return; }
        if (!remove_ && !TargetReady()) { Complete(HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED)); return; }
        selectedRoot_ = directory_;
        if (hasCurrent_) oldProduct_ = current_;
        replacement_ = !remove_ && hasCurrent_ && ReplaceNeeded(current_, candidate_, directory_);
        if (!remove_) {
            if (!SetInstallVariables(directory_)) return;
        }
        active_ = true; ShowPage(3);
        phase_ = replacement_ ? Phase::Prepare : Phase::Normal;
        PlanStage(remove_ ? BOOTSTRAPPER_ACTION_UNINSTALL : replacement_ ? BOOTSTRAPPER_ACTION_INSTALL : installed_ ? BOOTSTRAPPER_ACTION_REPAIR : BOOTSTRAPPER_ACTION_INSTALL);
    }
    void Launch() {
        if (reinterpret_cast<INT_PTR>(ShellExecuteW(window_, L"open", Exe().c_str(), nullptr, directory_.c_str(), SW_SHOWNORMAL)) <= 32)
            Error(T(L"앱을 자동으로 시작하지 못했습니다. 설치 폴더에서 앱을 실행해주세요.", L"The app could not start automatically. Run it from the installation folder."));
    }
    void ResetRetryState() {
        phase_ = Phase::Normal; replacement_ = false; prepared_ = false; forceFamilyRemoval_ = false;
        active_ = false; finished_ = false; failed_ = false; rebootRequired_ = false;
        detecting_ = false; retryDetect_ = false;
        detected_ = false; installed_ = false; eligibleCleanup_ = false;
        EnterCriticalSection(&m_csCanceled);
        m_fCanceled = FALSE;
        // The frozen SDK's rollback flag is private. Its forward-execution
        // state hook resets that flag and retry accounting without requesting
        // any engine/MSI operation. Previous rollback has already completed.
        if (IsRollingBack()) {
            BOOL cancel = FALSE;
            CBootstrapperApplicationBase::OnExecutePackageBegin(L"Application", TRUE, BOOTSTRAPPER_ACTION_STATE_NONE, INSTALLUILEVEL_NONE, FALSE, &cancel);
        }
        LeaveCriticalSection(&m_csCanceled);
        // applyStarted_ is the lifetime transaction history. It must survive a
        // retry so shutdown never skips normal cleanup after an earlier Apply.
        // Keep the last failure for diagnostics. A later explicit user Cancel
        // still exits with 1602, preserving the pre-Apply shutdown protection.
    }
    void RefreshInstallLocation() {
        registered_ = FullPath(ReadString(HKEY_CURRENT_USER, kRegistry, L"InstallLocation"));
        if (!registered_.empty() && !selectionMade_ && phase_ != Phase::Redetect) directory_ = registered_;
    }
    bool RemovalShortcut(bool remove) {
        std::wstring target, digest;
        if (!remove) {
            wchar_t bundle[128]{}, currentVersion[128]{}; SIZE_T length = 128;
            if (FAILED(m_pEngine->GetVariableString(L"WixBundleProviderKey", bundle, &length))) return false;
            length = 128;
            if (FAILED(m_pEngine->GetVariableVersion(L"WixBundleVersion", currentVersion, &length))) return false;
            std::wstring key = std::wstring(kUninstallRegistry) + bundle;
            auto version = ReadString(HKEY_CURRENT_USER, key.c_str(), L"DisplayVersion");
            target = RemovalCachePath(KnownFolder(FOLDERID_LocalAppData), bundle, version);
            int comparison = 0; DWORD installed = 0, scope = 0, size = sizeof(DWORD);
            if (target.empty() || FAILED(m_pEngine->CompareVersions(version.c_str(), currentVersion, &comparison)) || comparison ||
                !RegistrationProduct(ReadString(HKEY_CURRENT_USER, key.c_str(), L"DisplayName")) ||
                ReadString(HKEY_CURRENT_USER, key.c_str(), L"Publisher") != L"DMeloper" ||
                _wcsicmp(ReadString(HKEY_CURRENT_USER, key.c_str(), L"BundleProviderKey").c_str(), bundle) != 0 ||
                !EqualPath(ReadString(HKEY_CURRENT_USER, key.c_str(), L"BundleCachePath"), target) || FileHash(target).empty()) return false;
            if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), L"Installed", RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &installed, &size) != ERROR_SUCCESS || installed != 1) return false;
            size = sizeof(DWORD);
            if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), L"BundleScope", RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &scope, &size) != ERROR_SUCCESS || scope != 2) return false;
        }
        bool ok = ShortcutFile(directory_ + L"\\" + kRemovalLink, target, L"/uninstall",
                               T(L"DMeloper's Block Pet 제거", L"Uninstall DMeloper's Block Pet"),
                               Exe(), ReadString(HKEY_CURRENT_USER, kReceipts, L"Uninstall"), remove, true, digest);
        return ok && (digest.empty() || WriteReceipt(L"Uninstall", digest));
    }
    void BeginDetect(bool notifyError = true) {
        retryDetect_ = false; detecting_ = true; notifyDetectError_ = notifyError;
        detected_ = false; installed_ = false; eligibleCleanup_ = false;
        RefreshInstallLocation();
        EnableWindow(next_, FALSE);
        SetWindowTextW(next_, T(L"다음(&N) >", L"&Next >"));
        webviewFailed_ = false;
        HRESULT hr = ProbeProducts() ? S_OK : HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
        if (SUCCEEDED(hr) && !PendingGhostsValid()) hr = HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
        if (SUCCEEDED(hr) && managedWebView_) hr = m_pEngine->SetVariableNumeric(L"WebViewAvailable", WebViewAvailable() ? 1 : 0);
        if (SUCCEEDED(hr)) hr = m_pEngine->Detect(window_);
        if (FAILED(hr)) Complete(hr);
    }
    void Complete(HRESULT hr, bool showFailure = true) {
        if (SUCCEEDED(hr) && !related_) {
            if (remove_ && (!hasCurrent_ || !RemovedProduct())) hr = HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE);
            if (!remove_) {
                ProductIdentity installed;
                if (!ReadOwnedProduct(candidate_.product, sid_, installed) || !EqualText(installed.package, candidate_.package) ||
                    !EqualPath(ReadString(HKEY_CURRENT_USER, kRegistry, L"InstallLocation"), directory_) || FileHash(Exe()).empty()) hr = HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE);
                else newInstalled_ = true;
            }
        }
        if (SUCCEEDED(hr) && !related_) {
            if ((!oldBundles_.empty() && (newInstalled_ || remove_)) && !RetireOldBundles()) hr = HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE);
            if (SUCCEEDED(hr) && !ghosts_.empty() && !RetireGhostBundles()) hr = HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE);
        }
        bool detectFailure = detecting_;
        detecting_ = false;
        active_ = false; finished_ = true; failed_ = FAILED(hr);
        exitCode_ = failed_ ? (HRESULT_FACILITY(hr) == FACILITY_WIN32 ? HRESULT_CODE(hr) : static_cast<DWORD>(hr)) : rebootRequired_ ? ERROR_SUCCESS_REBOOT_REQUIRED : 0;
        if (!failed_ && !related_) {
            bool ok = true;
            if (!remove_) {
                ok &= Shortcut(KnownFolder(FOLDERID_Desktop), Exe(), L"Desktop", !desktop_);
                ok &= Shortcut(KnownFolder(FOLDERID_Programs), Exe(), L"StartMenu", !start_);
                ok &= RemovalShortcut(!removalLink_);
                if (oldRun_.empty()) CaptureOwnedRun(Exe(), true);
                RestoreOwnedRun();
            } else {
                CleanupOwned(oldRoot_, false);
            }
            if (!ok) m_pEngine->Log(BOOTSTRAPPER_LOG_LEVEL_STANDARD, L"Shortcut post-processing could not complete.");
        }
        if (mutex_) { CloseHandle(mutex_); mutex_ = nullptr; }
        if (failed_ && InteractiveRetry()) {
            lastFailure_ = hr;
            std::wstring message = FailureText(hr, korean_);
            if (oldRemoved_) message += newInstalled_
                ? T(L"\r\n\r\n새 앱 설치는 확인됐지만 이번 작업을 모두 완료하지 못했습니다. 개인 데이터는 유지됩니다. 다시 시도하여 남은 작업을 완료하세요.", L"\r\n\r\nThe new app installation was verified, but setup could not complete all remaining work. Your personal data is retained. Retry to finish.")
                : T(L"\r\n\r\n기존 설치 등록은 제거됐지만 새 설치는 완료되지 않았습니다. 개인 데이터는 유지됩니다. 다시 시도하여 설치를 완료하세요.", L"\r\n\r\nThe previous installation registration was removed, but the new installation did not complete. Your personal data is retained. Retry to finish installing.");
            m_pEngine->Log(BOOTSTRAPPER_LOG_LEVEL_ERROR, message.c_str());
            if (showFailure && (!detectFailure || notifyDetectError_))
                MessageBoxW(window_, message.c_str(), T(L"작업을 완료하지 못했습니다", L"Setup could not complete"), MB_OK | MB_ICONERROR);
            ResetRetryState();
            RefreshInstallLocation();
            SendMessageW(desktopBox_, BM_SETCHECK, desktop_ ? BST_CHECKED : BST_UNCHECKED, 0);
            SendMessageW(startBox_, BM_SETCHECK, start_ ? BST_CHECKED : BST_UNCHECKED, 0);
            SendMessageW(progress_, PBM_SETPOS, 0, 0);
            detecting_ = !detectFailure;
            ShowPage(0);
            if (detectFailure) {
                retryDetect_ = true;
                SetWindowTextW(next_, T(L"재시도(&R)", L"&Retry"));
                std::wstring hint = std::wstring(T(L"설치 상태를 확인하지 못했습니다.", L"Installation state check failed.")) + L"\r\n" + ErrorCodeText(hr, korean_) + L"\r\n" + T(L"다시 시도를 눌러 확인을 다시 시작하세요.", L"Select Retry to check again.");
                SetWindowTextW(text_, hint.c_str());
                SetFocus(next_);
            } else BeginDetect(false);
            return;
        }
        if (!failed_) lastFailure_ = S_OK;
        if (automatic_ && (Unattended() || !failed_)) { if (!failed_ && !quiet_ && !rebootRequired_ && restart_ && !remove_) Launch(); Close(exitCode_); }
        else ShowPage(4);
    }
    void Browse() {
        IFileDialog* dialog = nullptr;
        if (SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) {
            DWORD flags = 0; dialog->GetOptions(&flags); dialog->SetOptions(flags | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
            if (SUCCEEDED(dialog->Show(window_))) {
                IShellItem* item = nullptr;
                if (SUCCEEDED(dialog->GetResult(&item))) {
                    PWSTR path = nullptr; if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) { SetWindowTextW(edit_, path); CoTaskMemFree(path); } item->Release();
                }
            }
            dialog->Release();
        }
    }
    void Advance() {
        if (InteractiveRetry() && retryDetect_) { BeginDetect(); return; }
        if (page_ == 4) { if (!failed_ && !remove_ && SendMessageW(runBox_, BM_GETCHECK, 0, 0) == BST_CHECKED) Launch(); Close(exitCode_); }
        else if (remove_) { if (page_ == 0) { deleteData_ = SendMessageW(deleteBox_, BM_GETCHECK, 0, 0) == BST_CHECKED; ShowPage(1); } else StartApply(); }
        else if (page_ == 0) ShowPage(1);
        else if (page_ == 1) {
            std::vector<wchar_t> path(32768); GetWindowTextW(edit_, path.data(), static_cast<int>(path.size()));
            directory_ = FullPath(path.data());
            if (!LocalPath(directory_)) { Error(T(L"수정 권한이 있는 사용자 로컬 설치 폴더를 선택해주세요.", L"Choose a local installation folder that your user account can modify.")); return; }
            if (GetFileAttributesW(Exe().c_str()) != INVALID_FILE_ATTRIBUTES && (!hasCurrent_ || !EqualPath(directory_, current_.root))) { Error(T(L"이 폴더의 파일이 현재 제품의 설치 파일인지 확인할 수 없습니다. 찾아보기에서 다른 폴더를 선택하세요.", L"Setup could not verify that the existing files belong to this installation. Browse to another folder.")); return; }
            selectionMade_ = true;
            ShowPage(2);
        } else if (page_ == 2) { desktop_ = SendMessageW(desktopBox_, BM_GETCHECK, 0, 0) == BST_CHECKED; start_ = SendMessageW(startBox_, BM_GETCHECK, 0, 0) == BST_CHECKED; StartApply(); }
    }
    static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM w, LPARAM l) {
        auto self = reinterpret_cast<BlockPetBootstrapper*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        if (message == WM_NCCREATE) { self = static_cast<BlockPetBootstrapper*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams); self->window_ = window; SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self)); }
        if (!self) return DefWindowProcW(window, message, w, l);
        switch (message) {
        case WM_PAINT: {
            PAINTSTRUCT paint{}; HDC dc = BeginPaint(window, &paint); self->PaintChrome(dc); EndPaint(window, &paint); return 0;
        }
        case WM_ERASEBKGND: self->PaintChrome(reinterpret_cast<HDC>(w)); return 1;
        case WM_CTLCOLORSTATIC: {
            HDC dc = reinterpret_cast<HDC>(w);
            SetBkMode(dc, TRANSPARENT); SetTextColor(dc, GetSysColor(COLOR_WINDOWTEXT));
            HWND control = reinterpret_cast<HWND>(l);
            return reinterpret_cast<LRESULT>(GetSysColorBrush(self->SidebarPage() || control == self->heading_ || control == self->subtitle_ ? COLOR_WINDOW : COLOR_BTNFACE));
        }
        case WM_CTLCOLORBTN:
            SetBkMode(reinterpret_cast<HDC>(w), TRANSPARENT);
            return reinterpret_cast<LRESULT>(GetSysColorBrush(self->SidebarPage() ? COLOR_WINDOW : COLOR_BTNFACE));
        case DM_GETDEFID:
            return IsWindowVisible(self->next_) && IsWindowEnabled(self->next_) ? MAKELONG(kNext, DC_HASDEFID) : 0;
        case WM_COMMAND:
            switch (LOWORD(w)) {
            case kFolder: if (HIWORD(w) == EN_CHANGE) self->UpdateDiskSpace(); break;
            case IDOK: if (IsWindowVisible(self->next_) && IsWindowEnabled(self->next_)) self->Advance(); break;
            case IDCANCEL: self->Cancel(); break;
            case kNext: self->Advance(); break; case kBack: self->ShowPage(self->page_ - 1); break; case kCancel: self->Cancel(); break; case kBrowse: self->Browse(); break;
            } return 0;
        case kDetected:
            if (FAILED(static_cast<HRESULT>(l))) { self->Complete(static_cast<HRESULT>(l)); return 0; }
            self->detecting_ = false;
            self->RefreshInstallLocation();
            if (self->phase_ == Phase::ReadyToRemove) { self->BeginOldRemoval(); return 0; }
            if (self->phase_ == Phase::Redetect) {
                if (self->hasCurrent_ || self->installed_) { self->Complete(HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE)); return 0; }
                self->phase_ = Phase::Install; self->directory_ = self->selectedRoot_;
                if (self->SetInstallVariables(self->directory_)) self->PlanStage(BOOTSTRAPPER_ACTION_INSTALL);
                return 0;
            }
            EnableWindow(self->next_, TRUE);
            if (!self->automatic_ && !self->remove_ && self->page_ == 0) SetFocus(self->next_);
            if (self->automatic_) self->StartApply(); return 0;
        case kPlanned:
            if (FAILED(static_cast<HRESULT>(l))) self->Complete(static_cast<HRESULT>(l));
            else if (self->CheckCanceled()) self->Complete(HRESULT_FROM_WIN32(ERROR_INSTALL_USEREXIT), false);
            else {
                if (!self->RemovalPlanReady()) {
                    self->Error(self->T(L"기존 설치 등록이 충돌하여 앱 제거가 계획되지 않았습니다. 앱과 개인 데이터는 그대로 유지됩니다.", L"Conflicting installation registrations prevented app removal from being planned. The app and personal data are unchanged."));
                    self->Complete(HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE), false); return 0;
                }
                if (self->remove_ && self->deleteData_ && !self->related_ && !self->CleanupData()) { self->Complete(HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE), false); return 0; }
                HRESULT hr = self->m_pEngine->Apply(window); if (FAILED(hr)) self->Complete(hr);
            } return 0;
        case kCompleted: if (!self->StageComplete(static_cast<HRESULT>(l))) self->Complete(static_cast<HRESULT>(l)); return 0;
        case kMsiRemoved: {
            if (self->removalThread_) { WaitForSingleObject(self->removalThread_, INFINITE); CloseHandle(self->removalThread_); self->removalThread_ = nullptr; }
            DWORD result = static_cast<DWORD>(w);
            self->OldRemovalComplete(result == 0 || result == ERROR_SUCCESS_REBOOT_REQUIRED || result == ERROR_SUCCESS_REBOOT_INITIATED ? S_OK : HRESULT_FROM_WIN32(result), result == ERROR_SUCCESS_REBOOT_REQUIRED || result == ERROR_SUCCESS_REBOOT_INITIATED);
            return 0;
        }
        case kProgress: SendMessageW(self->progress_, PBM_SETPOS, w, 0); return 0;
        case WM_CLOSE:
            self->Cancel(); return 0;
        case WM_DESTROY: self->window_ = nullptr; PostQuitMessage(0); return 0;
        }
        return DefWindowProcW(window, message, w, l);
    }
    static DWORD WINAPI UiThread(LPVOID parameter) { return static_cast<BlockPetBootstrapper*>(parameter)->RunUi(); }
    DWORD RunUi() {
        CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        INITCOMMONCONTROLSEX controls{ sizeof(controls), ICC_PROGRESS_CLASS }; InitCommonControlsEx(&controls);
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_SYSTEM_AWARE);
        dpi_ = GetDpiForSystem();
        const wchar_t* family = korean_ ? L"Malgun Gothic" : L"Segoe UI";
        font_ = CreateFontW(-MulDiv(12, dpi_, 96), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, family);
        titleFont_ = CreateFontW(-MulDiv(12, dpi_, 96), 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, family);
        welcomeFont_ = CreateFontW(-MulDiv(16, dpi_, 96), 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, family);
        // LoadIcon selects the small system-size frame. The artwork needs the
        // embedded 256px frame, privately owned rather than a shared-size cache.
        artworkIcon_ = static_cast<HICON>(LoadImageW(instance_, MAKEINTRESOURCEW(1), IMAGE_ICON, 256, 256, LR_DEFAULTCOLOR));
        WNDCLASSW cls{}; cls.hInstance = instance_; cls.lpfnWndProc = WindowProc; cls.lpszClassName = L"DMeloperBlockPetWixLocalUI"; cls.hCursor = LoadCursorW(nullptr, IDC_ARROW); cls.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1); cls.hIcon = LoadIconW(instance_, MAKEINTRESOURCEW(1));
        RegisterClassW(&cls);
        RECT rectangle{ 0, 0, MulDiv(kUiWidth, dpi_, 96), MulDiv(kUiHeight, dpi_, 96) }; AdjustWindowRectExForDpi(&rectangle, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, FALSE, 0, dpi_);
        window_ = CreateWindowExW(0, cls.lpszClassName, kDisplayProduct, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, (GetSystemMetrics(SM_CXSCREEN) - (rectangle.right - rectangle.left)) / 2, (GetSystemMetrics(SM_CYSCREEN) - (rectangle.bottom - rectangle.top)) / 2, rectangle.right - rectangle.left, rectangle.bottom - rectangle.top, nullptr, nullptr, instance_, this);
        if (!window_) { SetEvent(ready_); m_pEngine->Quit(ERROR_INSTALL_FAILURE); CoUninitialize(); return 1; }
        heading_ = Control(L"STATIC", L"", SS_LEFT | SS_NOPREFIX | WS_VISIBLE, 24, 14, 466, 25);
        subtitle_ = Control(L"STATIC", L"", SS_LEFT | SS_NOPREFIX | WS_VISIBLE, 24, 40, 466, 30);
        text_ = Control(L"STATIC", L"", SS_LEFT | SS_NOPREFIX | WS_VISIBLE, 24, 96, 512, 96);
        group_ = Control(L"BUTTON", L"", BS_GROUPBOX, 24, 208, 512, 114);
        details_ = Control(L"STATIC", L"", SS_LEFT | SS_NOPREFIX, 40, 276, 476, 34);
        space_ = Control(L"STATIC", L"", SS_LEFT | SS_NOPREFIX, 24, 316, 512, 34);
        path_ = Control(L"STATIC", L"", SS_LEFTNOWORDWRAP | SS_PATHELLIPSIS | SS_NOPREFIX, 40, 236, 476, 24);
        edit_ = Control(L"EDIT", L"", WS_BORDER | ES_AUTOHSCROLL | WS_TABSTOP, 40, 236, 374, 24, kFolder);
        browse_ = Control(L"BUTTON", T(L"찾아보기(&R)…", L"B&rowse…"), WS_TABSTOP, 424, 235, 96, 26, kBrowse);
        desktopBox_ = Control(L"BUTTON", T(L"바탕화면 바로가기 만들기(&D)", L"Create a &desktop shortcut"), BS_AUTOCHECKBOX | BS_MULTILINE | WS_TABSTOP, 40, 180, 476, 30, kDesktop);
        startBox_ = Control(L"BUTTON", T(L"시작 메뉴 바로가기 만들기(&S)", L"Create a &Start menu shortcut"), BS_AUTOCHECKBOX | BS_MULTILINE | WS_TABSTOP, 40, 222, 476, 30, kStart);
        runBox_ = Control(L"BUTTON", T(L"DMeloper's Block Pet 실행(&R)", L"&Run DMeloper's Block Pet"), BS_AUTOCHECKBOX | BS_MULTILINE | WS_TABSTOP, 188, 250, 348, 48, kRun);
        deleteBox_ = Control(L"BUTTON", T(L"모든 개인 설정 및 파일 제거(&D)", L"Remove all personal settings and files (&D)"), BS_AUTOCHECKBOX | BS_MULTILINE | WS_TABSTOP, 40, 188, 476, 30, kDelete);
        progress_ = Control(PROGRESS_CLASSW, L"", PBS_SMOOTH, 24, 158, 512, 22);
        back_ = Control(L"BUTTON", T(L"< 뒤로(&B)", L"< &Back"), WS_TABSTOP | WS_VISIBLE, 274, 366, 86, 24, kBack);
        next_ = Control(L"BUTTON", T(L"다음(&N) >", L"&Next >"), BS_DEFPUSHBUTTON | WS_TABSTOP | WS_VISIBLE, 360, 366, 86, 24, kNext);
        cancel_ = Control(L"BUTTON", T(L"취소", L"Cancel"), WS_TABSTOP | WS_VISIBLE, 460, 366, 86, 24, kCancel);
        SendMessageW(desktopBox_, BM_SETCHECK, desktop_ ? BST_CHECKED : BST_UNCHECKED, 0); SendMessageW(startBox_, BM_SETCHECK, start_ ? BST_CHECKED : BST_UNCHECKED, 0); SendMessageW(runBox_, BM_SETCHECK, BST_CHECKED, 0);
        ShowPage(automatic_ ? 3 : 0); EnableWindow(next_, FALSE); ShowWindow(window_, quiet_ || related_ ? SW_HIDE : SW_SHOW);
        SetEvent(ready_);
        if (!ParseCommand()) { Error(T(L"설치 또는 업데이트 요청을 확인할 수 없습니다.", L"The installation or update request could not be verified.")); Close(ERROR_INVALID_PARAMETER); }
        else {
            SendMessageW(deleteBox_, BM_SETCHECK, deleteData_ ? BST_CHECKED : BST_UNCHECKED, 0);
            BeginDetect();
        }
        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0) { if (!window_ || !IsDialogMessageW(window_, &message)) { TranslateMessage(&message); DispatchMessageW(&message); } }
        if (mutex_) { CloseHandle(mutex_); mutex_ = nullptr; }
        m_pEngine->Quit(exitCode_);
        DeleteObject(font_); DeleteObject(titleFont_); DeleteObject(welcomeFont_); CoUninitialize(); return 0;
    }
public:
#if defined(BP_BA_SELF_TEST)
    static bool TestLegacyShortcutMigration() {
        HRESULT apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (FAILED(apartment)) return false;
        wchar_t temporary[MAX_PATH]{}, reservation[MAX_PATH]{};
        bool ok = GetTempPathW(_countof(temporary), temporary) && GetTempFileNameW(temporary, L"bpl", 0, reservation);
        std::wstring folder = reservation;
        ok = ok && DeleteFileW(reservation) && CreateDirectoryW(folder.c_str(), nullptr);
        auto owned = folder + L"\\DMeloper's Block Pet WiX Local.lnk";
        auto edited = folder + L"\\DMeloper's Block Pet (Independent).lnk";
        auto canonical = folder + L"\\" + kProduct + L".lnk";
        auto oldTarget = folder + L"\\旧 한글\\" + kExe;
        auto newTarget = folder + L"\\新 한글\\" + kExe;
        auto foreignTarget = folder + L"\\foreign.exe";
        std::wstring receipt, migrated, editedHash;
        ok = ok && ShortcutFile(owned, oldTarget, L"", kDisplayProduct, L"", L"", false, false, receipt) &&
            !receipt.empty() && CopyFileW(owned.c_str(), edited.c_str(), TRUE);
        IShellLinkW* link = nullptr; IPersistFile* file = nullptr;
        if (ok) {
            ok = SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) &&
                SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(&file))) && SUCCEEDED(file->Load(edited.c_str(), STGM_READWRITE)) &&
                SUCCEEDED(link->SetPath(foreignTarget.c_str())) && SUCCEEDED(file->Save(edited.c_str(), TRUE));
        }
        if (file) file->Release(); if (link) link->Release(); file = nullptr; link = nullptr;
        editedHash = FileHash(edited);
        ok = ok && !editedHash.empty() && editedHash != receipt && ProductShortcutFile(folder, newTarget, receipt, false, migrated) &&
            GetFileAttributesW(owned.c_str()) == INVALID_FILE_ATTRIBUTES && FileHash(edited) == editedHash && !migrated.empty() && FileHash(canonical) == migrated;
        if (ok) {
            wchar_t path[32768]{}; WIN32_FIND_DATAW details{};
            ok = SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) &&
                SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(&file))) && SUCCEEDED(file->Load(canonical.c_str(), STGM_READ)) &&
                SUCCEEDED(link->GetPath(path, _countof(path), &details, SLGP_RAWPATH)) && EqualPath(path, newTarget);
        }
        if (file) file->Release(); if (link) link->Release();
        std::wstring unused;
        ok = ok && ProductShortcutFile(folder, oldTarget, L"", false, unused) && unused.empty() && FileHash(canonical) == migrated && FileHash(edited) == editedHash;
        ok = ok && OwnedRunValue(Quote(oldTarget), oldTarget) && OwnedRunValue(Quote(oldTarget) + L" ", oldTarget) &&
            !OwnedRunValue(Quote(oldTarget) + L" --hidden", oldTarget) && !OwnedRunValue(oldTarget, oldTarget) && !OwnedRunValue(Quote(foreignTarget), oldTarget);
        RemoveOwnedFile(owned, receipt); RemoveOwnedFile(canonical, migrated); RemoveOwnedFile(edited, editedHash);
        RemoveDirectoryW(folder.c_str()); CoUninitialize(); return ok;
    }
    static bool TestReplacementPlans() {
        if (!MsiBufferProbe(ERROR_SUCCESS, 0) || !MsiBufferProbe(ERROR_SUCCESS, 32) || !MsiBufferProbe(ERROR_MORE_DATA, 38) ||
            MsiBufferProbe(ERROR_ACCESS_DENIED, 0) || MsiBufferProbe(ERROR_UNKNOWN_PRODUCT, 0) || MsiBufferProbe(ERROR_MORE_DATA, 32769)) return false;
        if (!GhostEvidenceAccepted(true, true, false, false) || !GhostEvidenceAccepted(true, false, true, false) ||
            GhostEvidenceAccepted(false, true, true, false) || GhostEvidenceAccepted(true, false, false, false) || GhostEvidenceAccepted(true, true, true, true)) return false;
        ProductIdentity old;
        old.product = KnownProductCode(L"1.0.0"); old.package = L"{11111111-1111-4111-8111-111111111111}";
        old.version = L"1.0.0"; old.root = L"C:\\Unicode 시험\\old";
        ProductIdentity candidate = old;
        if (ReplaceNeeded(old, candidate, L"c:\\Unicode 시험\\OLD\\")) return false;
        candidate.package = L"{22222222-2222-4222-8222-222222222222}";
        if (!ReplaceNeeded(old, candidate, old.root)) return false;
        candidate.product = KnownProductCode(L"1.0.1"); candidate.version = L"1.0.1";
        if (ReplaceNeeded(old, candidate, old.root) || !ReplaceNeeded(old, candidate, L"C:\\Unicode 시험\\new")) return false;
        BlockPetBootstrapper setup;
        setup.remove_ = true;
        setup.OnPlannedPackage(L"Application", BOOTSTRAPPER_ACTION_STATE_NONE, BOOTSTRAPPER_ACTION_STATE_NONE, FALSE, FALSE);
        if (setup.RemovalPlanReady()) return false;
        setup.OnPlannedPackage(L"WebView2", BOOTSTRAPPER_ACTION_STATE_UNINSTALL, BOOTSTRAPPER_ACTION_STATE_NONE, FALSE, FALSE);
        if (setup.RemovalPlanReady()) return false;
        setup.OnPlannedPackage(L"Application", BOOTSTRAPPER_ACTION_STATE_UNINSTALL, BOOTSTRAPPER_ACTION_STATE_NONE, FALSE, FALSE);
        if (!setup.RemovalPlanReady()) return false;
        setup.plannedApplication_ = BOOTSTRAPPER_ACTION_STATE_NONE; setup.related_ = true;
        if (!setup.RemovalPlanReady()) return false;
        setup.related_ = false; setup.remove_ = false; setup.phase_ = Phase::RemoveBurn;
        if (setup.RemovalPlanReady()) return false;
        setup.phase_ = Phase::Prepare;
        BOOL cancel = FALSE; BOOTSTRAPPER_REQUEST_STATE requested = BOOTSTRAPPER_REQUEST_STATE_REPAIR;
        BOOTSTRAPPER_CACHE_TYPE cache = BOOTSTRAPPER_CACHE_TYPE_KEEP;
        setup.OnPlanPackageBegin(L"Application", BOOTSTRAPPER_PACKAGE_STATE_PRESENT, TRUE, BOOTSTRAPPER_PACKAGE_CONDITION_DEFAULT, BOOTSTRAPPER_PACKAGE_CONDITION_DEFAULT,
            requested, cache, &requested, &cache, &cancel);
        if (cancel || requested != BOOTSTRAPPER_REQUEST_STATE_CACHE || cache != BOOTSTRAPPER_CACHE_TYPE_FORCE || !setup.RemovalPlanReady()) return false;
        setup.OnPlanPackageBegin(L"WebView2", BOOTSTRAPPER_PACKAGE_STATE_ABSENT, FALSE, BOOTSTRAPPER_PACKAGE_CONDITION_DEFAULT, BOOTSTRAPPER_PACKAGE_CONDITION_DEFAULT,
            requested, cache, &requested, &cache, &cancel);
        if (requested != BOOTSTRAPPER_REQUEST_STATE_PRESENT) return false;
        requested = BOOTSTRAPPER_REQUEST_STATE_ABSENT;
        setup.OnPlanRelatedBundle(L"{11111111-1111-4111-8111-111111111111}", requested, &requested, &cancel);
        if (requested != BOOTSTRAPPER_REQUEST_STATE_NONE) return false;
        setup.phase_ = Phase::Install; setup.candidate_ = candidate; setup.candidate_.version = L"1.0.0";
        setup.oldBundles_.push_back({ old.product, L"1.0.0", L"C:\\cache.exe" });
        requested = BOOTSTRAPPER_REQUEST_STATE_ABSENT;
        setup.OnPlanRelatedBundle(old.product.c_str(), requested, &requested, &cancel);
        if (requested != BOOTSTRAPPER_REQUEST_STATE_NONE) return false;
        setup.oldProduct_ = old; setup.current_ = {}; setup.selectedRoot_ = L"C:\\Unicode 시험\\new"; setup.directory_ = setup.selectedRoot_;
        setup.ghosts_.push_back({ old.product, old.version, L"C:\\absent.exe", old.product + L"_v" + old.version });
        setup.selectionMade_ = true; setup.applyStarted_ = true; setup.ResetRetryState();
        if (setup.oldProduct_.product != old.product || setup.directory_ != setup.selectedRoot_ || !setup.selectionMade_ || !setup.applyStarted_ || setup.ghosts_.size() != 1) return false;
        if (KnownProductCode(L"1.0.0") != old.product || KnownProductCode(L"1.0.1") != candidate.product ||
            MsiRemovalUi(&setup, INSTALLMESSAGE_FILESINUSE | MB_RETRYCANCEL, 0) != IDCANCEL ||
            MsiRemovalUi(&setup, INSTALLMESSAGE_RMFILESINUSE | MB_ABORTRETRYIGNORE, 0) != IDCANCEL || MsiRemovalUi(&setup, INSTALLMESSAGE_PROGRESS, 0) != IDOK) return false;
#if defined(BP_OFFICIAL_BUILD)
        if (KnownProductCode(L"1.0.0") != L"{0BB3A6AA-6DD1-5F05-A40F-37DA82D896CD}" ||
            KnownProductCode(L"1.0.1") != L"{9AEADDD4-2CAB-581F-99C1-722CE5381CA6}" ||
            KnownProductCode(L"1.0.2") != L"{38B4C1CA-16AE-508C-B207-2BBB57BE6897}" ||
            KnownProductCode(L"1.0.3") != L"{C8C2867E-1D8C-56CC-AD2E-A8A3406EE20E}" ||
            KnownProductCode(L"1.1.1") != L"{30654C54-2EF1-5146-B135-C12D13477C0F}" ||
            KnownProductCode(L"0.0.0") != L"{B09DD206-2E8C-586A-9D9B-7326FE345697}" ||
            KnownProductCode(L"65535.65535.65535") != L"{8D375323-FC40-5511-90A9-19141BA23341}") return false;
#else
        if (KnownProductCode(L"1.0.0") != L"{ABA6A476-9128-5421-B39A-E19FA42FB0C8}" ||
            KnownProductCode(L"1.0.1") != L"{EF7EC346-73F1-5CAB-9E09-EC9981BC63A3}" ||
            KnownProductCode(L"1.0.2") != L"{98C2AFA2-0EED-5B73-BFC5-93FA21239246}" ||
            KnownProductCode(L"1.0.3") != L"{715E6473-DF2B-58A4-A640-E2A5B5E005DF}" ||
            KnownProductCode(L"1.1.1") != L"{B7F410F5-E0C9-56BE-A122-D3EB26971397}" ||
            KnownProductCode(L"0.0.0") != L"{7F2EE652-CE35-5FF1-BA57-96701A694108}" ||
            KnownProductCode(L"65535.65535.65535") != L"{178303F5-B601-5346-B166-C6FFAE18A09B}") return false;
#endif
        for (const wchar_t* invalid : { L"", L"1", L"1.0", L"1.0.0.0", L"01.0.0", L"1.00.0", L"1.0.00", L"1.0.-1",
                L"1.0.0-beta", L"1.0.0+build", L"v1.0.0", L"1.0.0 ", L" 1.0.0", L"1.0.0\n", L"65536.0.0", L"0.65536.0",
                L"0.0.65536", L"999999999999999999999.0.0", L"1.0.０", L"1/0/0" })
            if (!KnownProductCode(invalid).empty()) return false;
        if (!KnownProductCode(std::wstring(L"1.0.0\0suffix", 12)).empty()) return false;
        ProductIdentity futureOld = old, futureCandidate = old;
        futureOld.product = KnownProductCode(L"1.0.2"); futureOld.version = L"1.0.2";
        futureCandidate.product = KnownProductCode(L"1.0.3"); futureCandidate.version = L"1.0.3";
        if (ReplaceNeeded(futureOld, futureCandidate, old.root) || !ReplaceNeeded(futureOld, futureCandidate, L"C:\\Unicode 시험\\next")) return false;
        futureCandidate = futureOld; futureCandidate.package = L"{22222222-2222-4222-8222-222222222222}";
        if (!ReplaceNeeded(futureOld, futureCandidate, old.root)) return false;
        setup.active_ = true; setup.quiet_ = true; setup.Cancel();
        return setup.CheckCanceled() && MsiRemovalUi(&setup, INSTALLMESSAGE_PROGRESS, 0) == IDCANCEL;
    }
    static bool TestDiskSpace() {
        if (SpaceBytes(0) != L"0 B" || SpaceBytes(1024) != L"1.0 KiB" ||
            SpaceBytes(16844764) != L"16.1 MiB" || SpaceBytes(5ULL << 30) != L"5.0 GiB") return false;
        for (bool korean : { false, true }) {
            auto text = SpaceSummary(16844764, true, 5ULL << 30, korean);
            if (text.find(L"16.1 MiB") == std::wstring::npos || text.find(L"5.0 GiB") == std::wstring::npos ||
                text.find(korean ? L"사용 가능한 디스크 공간:" : L"Space available:") == std::wstring::npos) return false;
            if (SpaceSummary(0, false, 0, korean).find(korean ? L"확인할 수 없음" : L"Unavailable") == std::wstring::npos ||
                SpaceSummary(1, true, 0, korean).find(L"0 B") == std::wstring::npos) return false;
        }
        ULONGLONG available = 17;
        for (LPCWSTR path : { L"", L"C:", L"relative\\path", L"C:relative", L"\\\\server\\share", L"9:\\bad",
                              L"C:\\invalid?folder", L"C:\\invalid|folder", L"C:\\bad:stream", L"C:\\bad\nfolder" })
            if (AvailableSpace(path, available) || available != 17) return false;
        wchar_t temporary[MAX_PATH]{}, file[MAX_PATH]{};
        if (!GetTempPathW(MAX_PATH, temporary) || !GetTempFileNameW(temporary, L"bps", 0, file)) return false;
        bool fileRejected = !AvailableSpace(file, available);
        if (!DeleteFileW(file) || !fileRejected) return false;
        std::wstring missing = std::wstring(file) + L"\\새 폴더\\Block Pet";
        if (GetFileAttributesW(missing.c_str()) != INVALID_FILE_ATTRIBUTES || !AvailableSpace(missing, available)) return false;

        // Exercise the actual EDIT notification and page guard in an invisible
        // fixture window. No installer engine, registration or app is started.
        BlockPetBootstrapper setup;
        WNDCLASSW cls{}; cls.hInstance = setup.instance_; cls.lpfnWndProc = WindowProc; cls.lpszClassName = L"BlockPetSpaceControlFixture";
        if (!RegisterClassW(&cls)) return false;
        HWND parent = CreateWindowExW(0, cls.lpszClassName, L"", WS_POPUP, 0, 0, kUiWidth, kUiHeight, nullptr, nullptr, setup.instance_, &setup);
        bool ok = parent != nullptr;
        if (parent) {
            setup.page_ = 1; setup.installedSize_ = 16844764;
            setup.space_ = setup.Control(L"STATIC", L"", SS_LEFT, 24, 316, 512, 34);
            setup.edit_ = setup.Control(L"EDIT", L"", ES_AUTOHSCROLL, 40, 236, 374, 24, kFolder);
            wchar_t text[512]{};
            ok = setup.space_ && setup.edit_ && SetWindowTextW(setup.edit_, missing.c_str());
            GetWindowTextW(setup.space_, text, _countof(text));
            ok &= std::wstring(text).find(L"16.1 MiB") != std::wstring::npos &&
                std::wstring(text).find(setup.korean_ ? L"확인할 수 없음" : L"Unavailable") == std::wstring::npos;
            SetWindowTextW(setup.edit_, L"relative"); GetWindowTextW(setup.space_, text, _countof(text));
            ok &= std::wstring(text).find(setup.korean_ ? L"확인할 수 없음" : L"Unavailable") != std::wstring::npos;
            std::wstring unchanged(text);
            setup.page_ = 2; SetWindowTextW(setup.edit_, missing.c_str()); GetWindowTextW(setup.space_, text, _countof(text));
            ok &= unchanged == text;
            setup.page_ = 1; setup.remove_ = true;
            SetWindowTextW(setup.edit_, temporary); GetWindowTextW(setup.space_, text, _countof(text)); ok &= unchanged == text;
            SetWindowLongPtrW(parent, GWLP_USERDATA, 0); DestroyWindow(parent); setup.window_ = nullptr;
        }
        UnregisterClassW(cls.lpszClassName, setup.instance_); return ok;
    }
    static bool TestInteractiveRetry() {
        BlockPetBootstrapper setup;
        if (!setup.InteractiveRetry()) return false;
        setup.automatic_ = true; if (setup.InteractiveRetry()) return false;
        setup.automatic_ = false; setup.update_ = true; if (setup.InteractiveRetry()) return false;
        setup.update_ = false; setup.related_ = true; if (setup.InteractiveRetry()) return false;
        setup.related_ = false; setup.quiet_ = true; if (setup.InteractiveRetry()) return false;
        setup.quiet_ = false; setup.passive_ = true; if (setup.InteractiveRetry()) return false;
        setup.passive_ = false;
        setup.applyStarted_ = true; setup.active_ = true; setup.finished_ = true;
        setup.failed_ = true; setup.rebootRequired_ = true; setup.detected_ = true;
        setup.installed_ = true; setup.eligibleCleanup_ = true;
        setup.directory_ = L"C:\\Unicode 시험\\"; setup.desktop_ = false; setup.start_ = true;
        setup.lastFailure_ = HRESULT_FROM_WIN32(ERROR_PRODUCT_VERSION); setup.exitCode_ = ERROR_PRODUCT_VERSION;
        BOOL cancel = FALSE;
        setup.OnExecutePackageBegin(L"Application", FALSE, BOOTSTRAPPER_ACTION_STATE_UNINSTALL, INSTALLUILEVEL_NONE, FALSE, &cancel);
        if (!setup.IsRollingBack()) return false;
        setup.m_fCanceled = TRUE;
        setup.ResetRetryState();
        if (setup.CheckCanceled() || setup.IsRollingBack() || !setup.applyStarted_ || setup.active_ || setup.finished_ || setup.failed_ ||
            setup.rebootRequired_ || setup.detected_ || setup.installed_ || setup.eligibleCleanup_ || setup.desktop_ || !setup.start_ ||
            setup.directory_ != L"C:\\Unicode 시험\\" || setup.lastFailure_ != HRESULT_FROM_WIN32(ERROR_PRODUCT_VERSION)) return false;
        setup.m_fCanceled = TRUE;
        setup.OnPlanBegin(1, &cancel);
        if (!cancel) return false;
        cancel = FALSE; setup.OnCacheBegin(&cancel);
        if (!cancel) return false;
        setup.ResetRetryState();
        setup.OnDetectPackageComplete(L"Application", S_OK, BOOTSTRAPPER_PACKAGE_STATE_PRESENT, FALSE);
        setup.OnDetectComplete(S_OK, TRUE);
        BOOTSTRAPPER_SHUTDOWN_ACTION action = BOOTSTRAPPER_SHUTDOWN_ACTION_RESTART;
        setup.Cancel(); setup.OnShutdown(&action);
        if (setup.exitCode_ != ERROR_INSTALL_USEREXIT || action != BOOTSTRAPPER_SHUTDOWN_ACTION_NONE) return false;
        // A failed initial Detect, then successful Retry Detect, then explicit
        // Cancel still preserves the old pre-Apply registration/cache guard.
        BlockPetBootstrapper initial;
        initial.lastFailure_ = E_FAIL; initial.exitCode_ = static_cast<DWORD>(E_FAIL);
        initial.ResetRetryState();
        initial.OnDetectPackageComplete(L"Application", S_OK, BOOTSTRAPPER_PACKAGE_STATE_PRESENT, FALSE);
        initial.OnDetectComplete(S_OK, TRUE);
        initial.Cancel(); initial.OnShutdown(&action);
        if (initial.exitCode_ != ERROR_INSTALL_USEREXIT || action != BOOTSTRAPPER_SHUTDOWN_ACTION_SKIP_CLEANUP) return false;
        for (bool korean : { false, true }) {
            std::wstring conflict = FailureText(HRESULT_FROM_WIN32(ERROR_PRODUCT_VERSION), korean);
            if (conflict.find(L"0x80070666 (1638)") == std::wstring::npos ||
                conflict.find(korean ? L"사용자 데이터 삭제는 선택하지 마세요" : L"leaving user data removal unchecked") == std::wstring::npos) return false;
            if (FailureText(E_FAIL, korean).find(L"0x80004005") == std::wstring::npos) return false;
        }
        return true;
    }
    static bool TestWebViewPackageState() {
        BlockPetBootstrapper setup;
        setup.OnDetectPackageComplete(L"WebView2", S_OK, BOOTSTRAPPER_PACKAGE_STATE_PRESENT, FALSE);
        if (setup.installed_) return false;
        setup.OnDetectPackageComplete(L"Application", S_OK, BOOTSTRAPPER_PACKAGE_STATE_PRESENT, FALSE);
        setup.OnDetectPackageComplete(L"WebView2", S_OK, BOOTSTRAPPER_PACKAGE_STATE_ABSENT, FALSE);
        if (!setup.installed_) return false;
        setup.OnDetectPackageComplete(L"Application", E_FAIL, BOOTSTRAPPER_PACKAGE_STATE_PRESENT, FALSE);
        return !setup.installed_;
    }
    static int TestArtworkAndRepaint() {
        BlockPetBootstrapper setup;
        // Check the embedded group contains a real 256px source, not merely a
        // small frame resized by LoadImage to the requested output dimensions.
        HRSRC resource = FindResourceW(setup.instance_, MAKEINTRESOURCEW(1), RT_GROUP_ICON);
        DWORD length = resource ? SizeofResource(setup.instance_, resource) : 0;
        auto group = resource ? static_cast<const BYTE*>(LockResource(LoadResource(setup.instance_, resource))) : nullptr;
        if (!group || length < 6 || group[0] || group[1] || group[2] != 1 || group[3]) return 81;
        DWORD count = group[4] | (static_cast<DWORD>(group[5]) << 8);
        if (count > (length - 6) / 14) return 81;
        bool source256 = false;
        for (DWORD index = 0; index < count; ++index) {
            const BYTE* entry = group + 6 + index * 14;
            WORD id = entry[12] | (static_cast<WORD>(entry[13]) << 8);
            HRSRC frame = FindResourceW(setup.instance_, MAKEINTRESOURCEW(id), RT_ICON);
            if (!entry[0] && !entry[1] && frame && SizeofResource(setup.instance_, frame)) source256 = true;
        }
        if (!source256) return 82;
        setup.artworkIcon_ = static_cast<HICON>(LoadImageW(setup.instance_, MAKEINTRESOURCEW(1), IMAGE_ICON, 256, 256, LR_DEFAULTCOLOR));
        ICONINFO iconInfo{}; BITMAP bitmap{};
        bool iconOk = setup.artworkIcon_ && GetIconInfo(setup.artworkIcon_, &iconInfo) && iconInfo.hbmColor &&
            GetObjectW(iconInfo.hbmColor, sizeof(bitmap), &bitmap) == sizeof(bitmap) && bitmap.bmWidth == 256 && bitmap.bmHeight == 256;
        int result = iconOk ? 0 : 83;
        if (iconInfo.hbmColor) DeleteObject(iconInfo.hbmColor);
        if (iconInfo.hbmMask) DeleteObject(iconInfo.hbmMask);
        HDC dc = CreateCompatibleDC(nullptr);
        BITMAPINFO image{}; image.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        image.bmiHeader.biWidth = kUiWidth; image.bmiHeader.biHeight = -kUiHeight;
        image.bmiHeader.biPlanes = 1; image.bmiHeader.biBitCount = 32; image.bmiHeader.biCompression = BI_RGB;
        void* pixels = nullptr;
        HBITMAP canvas = dc ? CreateDIBSection(dc, &image, DIB_RGB_COLORS, &pixels, nullptr, 0) : nullptr;
        setup.font_ = CreateFontW(-12, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
        setup.titleFont_ = CreateFontW(-12, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
        if (canvas && setup.font_ && setup.titleFont_) {
            HGDIOBJ old = SelectObject(dc, canvas);
            if ((!old || old == HGDI_ERROR || GetCurrentObject(dc, OBJ_BITMAP) != canvas) && !result) result = 89;
            auto pixel = [&](int x, int y) -> COLORREF {
                if (!GdiFlush()) return CLR_INVALID;
                DWORD raw = static_cast<const DWORD*>(pixels)[y * kUiWidth + x];
                return RGB((raw >> 16) & 255, (raw >> 8) & 255, raw & 255);
            };
            // Obtain reference pixels from the same DC/system brushes. Their
            // flushed DIB bytes avoid environment-dependent GetPixel sampling.
            RECT reference{ 0, 0, kUiWidth, kUiHeight };
            FillRect(dc, &reference, GetSysColorBrush(COLOR_BTNFACE)); COLORREF body = pixel(8, 220);
            FillRect(dc, &reference, GetSysColorBrush(COLOR_WINDOW)); COLORREF header = pixel(8, 20);
            if ((body == CLR_INVALID || header == CLR_INVALID) && !result) result = 88;
            setup.page_ = 0; setup.PaintChrome(dc);
            if (pixel(8, 220) == body && !result) result = 85;
            setup.page_ = 1; setup.PaintChrome(dc);
            if ((pixel(8, 220) != body || pixel(8, 20) != header) && !result) result = 86;
            // Simulate an old folder group's border before painting shortcuts.
            MoveToEx(dc, 24, 208, nullptr); LineTo(dc, 536, 208);
            setup.page_ = 2; setup.PaintChrome(dc);
            if (pixel(24, 208) != body && !result) result = 87;
            SelectObject(dc, old);
        } else if (!result) result = 84;
        if (canvas) DeleteObject(canvas);
        if (dc) DeleteDC(dc);
        if (setup.font_) DeleteObject(setup.font_);
        if (setup.titleFont_) DeleteObject(setup.titleFont_);
        if (setup.artworkIcon_) DestroyIcon(setup.artworkIcon_);
        return result;
    }
    static bool TestTextMetrics() {
        // Measure only: no window, message loop, screenshots or input synthesis.
        // Include the longest bilingual copy in each constrained text region.
        struct TextRegion { LPCWSTR text; int width, height, size, weight; };
        const TextRegion regions[] = {
            { L"Welcome to DMeloper's Block Pet", 348, 76, 16, FW_BOLD },
            { L"DMeloper's Block Pet 설치", 348, 76, 16, FW_BOLD },
            { L"This wizard installs DMeloper's Block Pet for your Windows account.\r\n\r\nSelect Next to continue.", 348, 178, 12, FW_NORMAL },
            { L"이 마법사는 현재 Windows 계정에 DMeloper's Block Pet을 설치합니다.\r\n\r\n계속하려면 다음을 누르세요.", 348, 178, 12, FW_NORMAL },
            { L"Close the app before installing. Reinstall to the same folder to keep settings, presets and skins. Updates can also be installed from the app. Repair after an interrupted installation is manual.", 512, 96, 12, FW_NORMAL },
            { L"Choose whether to keep or remove your personal settings and files.", 466, 30, 12, FW_NORMAL },
            { L"개인 설정과 파일을 유지할지 삭제할지 선택하세요.", 466, 30, 12, FW_NORMAL },
            { L"Selecting this option removes this installation's settings, presets and skins. Other installations' data is kept.", 476, 72, 12, FW_NORMAL },
            { L"선택하면 이 설치의 설정·프리셋·스킨 등 사용자 데이터를 모두 삭제합니다. 다른 설치의 데이터에는 영향을 주지 않습니다.", 476, 72, 12, FW_NORMAL },
            { L"Installation is complete. Choose whether to run the app, then select Finish to close this wizard.", 348, 114, 12, FW_NORMAL },
            { L"DMeloper's Block Pet 실행(R)", 328, 48, 12, FW_NORMAL },
            { L"Run DMeloper's Block Pet", 328, 48, 12, FW_NORMAL },
            { L"사용자 데이터: 모두 삭제", 476, 28, 12, FW_NORMAL },
            { L"User data: remove all", 476, 28, 12, FW_NORMAL },
            { L"필요한 디스크 공간: 16.1 MiB\r\n사용 가능한 디스크 공간: 확인할 수 없음", 512, 34, 12, FW_NORMAL },
            { L"Space required: 8192.0 PiB\r\nSpace available: Unavailable", 512, 34, 12, FW_NORMAL },
            { L"폴더를 변경해도 개인 데이터는 유지됩니다.", 476, 20, 12, FW_NORMAL },
            { L"Changing the folder keeps your personal data.", 476, 20, 12, FW_NORMAL },
        };
        HDC dc = CreateCompatibleDC(nullptr); if (!dc) return false;
        bool ok = true;
        for (int dpi : { 96, 120, 144, 192 }) for (LPCWSTR family : { L"Segoe UI", L"Malgun Gothic" }) for (const auto& region : regions) {
            HFONT font = CreateFontW(-MulDiv(region.size, dpi, 96), 0, 0, 0, region.weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, family);
            if (!font) { ok = false; continue; }
            HGDIOBJ old = SelectObject(dc, font);
            RECT rectangle{ 0, 0, MulDiv(region.width, dpi, 96), 0 };
            int height = DrawTextW(dc, region.text, -1, &rectangle, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
            if (height <= 0 || height > MulDiv(region.height, dpi, 96)) ok = false;
            SelectObject(dc, old); DeleteObject(font);
        }
        DeleteDC(dc); return ok;
    }
    static bool TestCommandRules() {
        if (!RegistrationProduct(kDisplayProduct) || RegistrationProduct(L"DMeloper's Block Pet (Independent)") ||
            RegistrationProduct(L"DMeloper's Block Pet WiX Local") || RegistrationProduct(L"DMeloper's Block Pet extra")) return false;
        if (!AutomaticDisplay(BOOTSTRAPPER_DISPLAY_NONE) || !AutomaticDisplay(BOOTSTRAPPER_DISPLAY_PASSIVE) || AutomaticDisplay(BOOTSTRAPPER_DISPLAY_FULL)) return false;
        BlockPetBootstrapper setup;
        setup.rawCommand_ = L"--bp-delete-user-data";
        if (setup.ParseCommand()) return false;
        setup.remove_ = true;
        if (!setup.ParseCommand() || !setup.deleteData_) return false;
        setup.deleteData_ = false; setup.related_ = true;
        if (setup.ParseCommand()) return false;
        setup.rawCommand_ = L"--bp-unknown";
        if (setup.ParseCommand()) return false;
        setup.rawCommand_ = L"--bp-attempt xyz";
        if (setup.ParseCommand()) return false;
        setup.related_ = false; setup.rawCommand_.clear(); setup.attempt_.clear();
        return setup.ParseCommand() && !setup.deleteData_;
    }
    static bool TestCanceledCleanup() {
        BlockPetBootstrapper setup;
        BOOTSTRAPPER_SHUTDOWN_ACTION action = BOOTSTRAPPER_SHUTDOWN_ACTION_RESTART;
        setup.OnShutdown(&action);
        if (action != BOOTSTRAPPER_SHUTDOWN_ACTION_NONE) return false;
        // Reproduce the Burn callbacks from the stale, pre-Apply cancellation:
        // MSI present, own bundle absent but cached, eligible for engine cleanup.
        setup.OnDetectPackageComplete(L"Application", S_OK, BOOTSTRAPPER_PACKAGE_STATE_PRESENT, FALSE);
        setup.OnDetectComplete(S_OK, TRUE);
        setup.OnShutdown(&action);
        if (action != BOOTSTRAPPER_SHUTDOWN_ACTION_SKIP_CLEANUP) return false;
        struct Case { DWORD exit; bool detected, present, eligible, applied, related; };
        const Case normalCleanup[] = {
            { ERROR_SUCCESS, true, true, true, true, false }, // Successful repair.
            { ERROR_SUCCESS, true, false, true, true, false }, // Successful uninstall.
            { ERROR_INSTALL_USEREXIT, true, true, true, true, false }, // Apply cancellation/rollback.
            { ERROR_INSTALL_FAILURE, true, true, true, true, false }, // Failed transaction.
            { ERROR_INSTALL_USEREXIT, true, true, true, false, true }, // Related bundle cleanup.
            { ERROR_INSTALL_USEREXIT, true, false, true, false, false }, // Fresh install canceled.
            { ERROR_INSTALL_USEREXIT, false, true, true, false, false }, // Failed/missing detect.
            { ERROR_INSTALL_USEREXIT, true, true, false, false, false }, // Not eligible for cleanup.
            { ERROR_INSTALL_FAILURE, true, true, true, false, false }, // Preflight failure.
        };
        for (const auto& test : normalCleanup) {
            setup.exitCode_ = test.exit; setup.detected_ = test.detected; setup.installed_ = test.present;
            setup.eligibleCleanup_ = test.eligible; setup.applyStarted_ = test.applied; setup.related_ = test.related;
            setup.OnShutdown(&action);
            if (action != BOOTSTRAPPER_SHUTDOWN_ACTION_NONE) return false;
        }
        setup.exitCode_ = ERROR_INSTALL_USEREXIT; setup.related_ = false; setup.applyStarted_ = false;
        setup.OnDetectComplete(E_FAIL, TRUE);
        setup.OnShutdown(&action);
        if (action != BOOTSTRAPPER_SHUTDOWN_ACTION_NONE) return false;
        setup.OnDetectComplete(S_OK, TRUE);
        BOOL cancel = FALSE;
        setup.OnApplyBegin(1, &cancel);
        setup.OnShutdown(&action);
        return !cancel && action == BOOTSTRAPPER_SHUTDOWN_ACTION_NONE;
    }
#endif
    STDMETHODIMP OnCreate(IBootstrapperEngine* engine, BOOTSTRAPPER_COMMAND* command) override {
        HRESULT hr = CBootstrapperApplicationBase::OnCreate(engine, command); if (FAILED(hr)) return hr;
        candidate_.product = EngineString(L"ApplicationProductCode");
        candidate_.package = EngineString(L"ApplicationPackageCode");
        candidateSha_ = EngineString(L"ApplicationMsiSha256");
        wchar_t version[128]{}; SIZE_T versionLength = _countof(version);
        if (FAILED(engine->GetVariableVersion(L"WixBundleVersion", version, &versionLength)) || !CanonicalGuid(candidate_.product) || !CanonicalGuid(candidate_.package) ||
            candidateSha_.size() != 64 || candidateSha_.find_first_not_of(L"0123456789abcdef") != std::wstring::npos) return E_INVALIDARG;
        candidate_.version = version;
        auto known = KnownProductCode(candidate_.version);
#if defined(BP_OFFICIAL_BUILD)
        if (known.empty() || !EqualText(known, candidate_.product)) return E_INVALIDARG;
#else
        if (!known.empty() && !EqualText(known, candidate_.product)) return E_INVALIDARG;
#endif
        LONGLONG removalLink = 0;
        hr = engine->GetVariableNumeric(L"RemovalShortcut", &removalLink);
        if (FAILED(hr) || (removalLink != 0 && removalLink != 1)) return E_INVALIDARG;
        removalLink_ = removalLink != 0;
        LONGLONG managed = 0;
        hr = engine->GetVariableNumeric(L"WebViewManaged", &managed);
        if (SUCCEEDED(hr) && managed != 0 && managed != 1) return E_INVALIDARG;
        managedWebView_ = SUCCEEDED(hr) && managed == 1;
        LONGLONG installedSize = 0;
        if (SUCCEEDED(engine->GetVariableNumeric(L"InstalledPayloadBytes", &installedSize)) && installedSize > 0)
            installedSize_ = static_cast<ULONGLONG>(installedSize);
        action_ = command->action; remove_ = action_ == BOOTSTRAPPER_ACTION_UNINSTALL;
        rawCommand_ = command->wzCommandLine ? command->wzCommandLine : L"";
        update_ = rawCommand_.find(L"--bp-update") != std::wstring::npos;
        related_ = command->relationType != BOOTSTRAPPER_RELATION_NONE;
        quiet_ = command->display == BOOTSTRAPPER_DISPLAY_NONE;
        passive_ = command->display == BOOTSTRAPPER_DISPLAY_PASSIVE;
        automatic_ = update_ || related_ || AutomaticDisplay(command->display);
        registered_ = FullPath(ReadString(HKEY_CURRENT_USER, kRegistry, L"InstallLocation"));
        directory_ = registered_.empty() ? KnownFolder(FOLDERID_LocalAppData) + L"\\Programs\\" + kDisplayProduct : registered_;
        desktop_ = ReadChoice(L"DesktopShortcut"); start_ = ReadChoice(L"StartMenuShortcut");
        ready_ = CreateEventW(nullptr, TRUE, FALSE, nullptr); return ready_ ? S_OK : HRESULT_FROM_WIN32(GetLastError());
    }
    STDMETHODIMP OnStartup() override {
        uiThread_ = CreateThread(nullptr, 0, UiThread, this, 0, nullptr);
        if (!uiThread_) return HRESULT_FROM_WIN32(GetLastError());
        WaitForSingleObject(ready_, INFINITE); return S_OK;
    }
    STDMETHODIMP OnDetectPackageComplete(LPCWSTR package, HRESULT hr, BOOTSTRAPPER_PACKAGE_STATE state, BOOL) override {
        // Prerequisite presence must never become the application's installed state.
        if (package && wcscmp(package, L"Application") == 0)
            installed_ = SUCCEEDED(hr) && state == BOOTSTRAPPER_PACKAGE_STATE_PRESENT;
        return S_OK;
    }
    STDMETHODIMP OnDetectRelatedBundle(LPCWSTR code, BOOTSTRAPPER_RELATION_TYPE relation, LPCWSTR, BOOL machine, LPCWSTR version, BOOL, BOOL* cancel) override {
        Ghost ghost;
        if (!related_ && relation == BOOTSTRAPPER_RELATION_UPGRADE && !machine && code && version &&
            BundleIdentity(code, version, ghost, true) && ProductAbsentEverywhere(KnownProductCode(version), sid_)) {
            if (!IsGhost(code)) ghosts_.push_back(ghost);
            return S_OK;
        }
        if (!remove_ && relation == BOOTSTRAPPER_RELATION_UPGRADE) {
            wchar_t current[128]{}; SIZE_T length = 128; int comparison = 0;
            if (FAILED(m_pEngine->GetVariableVersion(L"WixBundleVersion", current, &length)) || FAILED(m_pEngine->CompareVersions(version, current, &comparison)) || comparison > 0) {
                *cancel = TRUE; return HRESULT_FROM_WIN32(ERROR_PRODUCT_VERSION);
            }
        }
        return S_OK;
    }
    STDMETHODIMP OnPlanRelatedBundle(LPCWSTR code, BOOTSTRAPPER_REQUEST_STATE recommendation, BOOTSTRAPPER_REQUEST_STATE* requested, BOOL* cancel) override {
        HRESULT hr = CBootstrapperApplicationBase::OnPlanRelatedBundle(code, recommendation, requested, cancel);
        auto ghost = std::find_if(ghosts_.begin(), ghosts_.end(), [&](const Ghost& item) { return code && EqualText(item.code, code); });
        if (ghost != ghosts_.end() && !VerifiedGhost(*ghost)) { *cancel = TRUE; return HRESULT_FROM_WIN32(ERROR_INVALID_DATA); }
        bool sameVersion = std::any_of(oldBundles_.begin(), oldBundles_.end(), [&](const Ghost& bundle) { return code && EqualText(bundle.code, code) && bundle.version == candidate_.version; });
        if (phase_ == Phase::Prepare || phase_ == Phase::RemoveBurn || IsGhost(code ? code : L"") || sameVersion) *requested = BOOTSTRAPPER_REQUEST_STATE_NONE;
        return hr;
    }
    STDMETHODIMP OnPlanPackageBegin(LPCWSTR package, BOOTSTRAPPER_PACKAGE_STATE state, BOOL cached,
        BOOTSTRAPPER_PACKAGE_CONDITION_RESULT installCondition, BOOTSTRAPPER_PACKAGE_CONDITION_RESULT repairCondition,
        BOOTSTRAPPER_REQUEST_STATE recommendation, BOOTSTRAPPER_CACHE_TYPE cacheRecommendation,
        BOOTSTRAPPER_REQUEST_STATE* requested, BOOTSTRAPPER_CACHE_TYPE* cache, BOOL* cancel) override {
        HRESULT hr = CBootstrapperApplicationBase::OnPlanPackageBegin(package, state, cached, installCondition, repairCondition, recommendation, cacheRecommendation, requested, cache, cancel);
        if (package && wcscmp(package, L"Application") == 0) {
            if (phase_ == Phase::Prepare) { *requested = BOOTSTRAPPER_REQUEST_STATE_CACHE; *cache = BOOTSTRAPPER_CACHE_TYPE_FORCE; }
            else if (((remove_ && !related_) || phase_ == Phase::RemoveBurn) && forceFamilyRemoval_) *requested = BOOTSTRAPPER_REQUEST_STATE_FORCE_ABSENT;
        } else if (package && wcscmp(package, L"WebView2") == 0) {
            if (phase_ == Phase::Prepare) *requested = BOOTSTRAPPER_REQUEST_STATE_PRESENT;
            else if (phase_ == Phase::RemoveBurn) *requested = BOOTSTRAPPER_REQUEST_STATE_NONE;
        }
        return hr;
    }
    STDMETHODIMP OnPlannedPackage(LPCWSTR package, BOOTSTRAPPER_ACTION_STATE execute, BOOTSTRAPPER_ACTION_STATE, BOOL, BOOL) override {
        if (package && wcscmp(package, L"Application") == 0) plannedApplication_ = execute;
        return S_OK;
    }
    STDMETHODIMP OnDetectComplete(HRESULT hr, BOOL eligible) override {
        if (SUCCEEDED(hr) && identityValid_ && installed_ && !hasCurrent_ && !related_) hr = HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
        detected_ = SUCCEEDED(hr); eligibleCleanup_ = eligible != FALSE;
        PostMessageW(window_, kDetected, 0, static_cast<LPARAM>(hr)); return S_OK;
    }
    STDMETHODIMP OnPlanComplete(HRESULT hr) override { PostMessageW(window_, kPlanned, 0, static_cast<LPARAM>(hr)); return S_OK; }
    STDMETHODIMP OnProgress(DWORD, DWORD overall, BOOL* cancel) override { *cancel |= CheckCanceled(); PostMessageW(window_, kProgress, overall, 0); return S_OK; }
    STDMETHODIMP OnError(BOOTSTRAPPER_ERROR_TYPE type, LPCWSTR package, DWORD code, LPCWSTR message, DWORD hint, DWORD count, LPCWSTR* data, int recommendation, int* result) override {
        if (!Unattended()) return CBootstrapperApplicationBase::OnError(type, package, code, message, hint, count, data, recommendation, result);
        std::wstring detail = L"Setup error " + std::to_wstring(code) + L": " + (message ? message : L"");
        m_pEngine->Log(BOOTSTRAPPER_LOG_LEVEL_ERROR, detail.c_str());
        *result = IDCANCEL; return S_OK;
    }
    STDMETHODIMP OnApplyBegin(DWORD phases, BOOL* cancel) override {
        applyStarted_ = true;
        return CBootstrapperApplicationBase::OnApplyBegin(phases, cancel);
    }
    STDMETHODIMP OnExecutePackageBegin(LPCWSTR package, BOOL execute, BOOTSTRAPPER_ACTION_STATE action,
                                       INSTALLUILEVEL ui, BOOL disableExternalUi, BOOL* cancel) override {
        HRESULT hr = CBootstrapperApplicationBase::OnExecutePackageBegin(package, execute, action, ui, disableExternalUi, cancel);
        if (SUCCEEDED(hr) && BlockAppWithoutWebView(package, execute, action, managedWebView_, WebViewAvailable())) {
            // A zero prerequisite exit code cannot authorize app writes by itself.
            webviewFailed_ = true;
            RequireWebView();
            *cancel = TRUE;
        }
        return hr;
    }
    STDMETHODIMP OnApplyComplete(HRESULT hr, BOOTSTRAPPER_APPLY_RESTART restart, BOOTSTRAPPER_APPLYCOMPLETE_ACTION, BOOTSTRAPPER_APPLYCOMPLETE_ACTION* action) override {
        if (webviewFailed_) hr = HRESULT_FROM_WIN32(ERROR_INSTALL_FAILURE);
        *action = BOOTSTRAPPER_APPLYCOMPLETE_ACTION_NONE;
        rebootRequired_ = SUCCEEDED(hr) && restart != BOOTSTRAPPER_APPLY_RESTART_NONE;
        PostMessageW(window_, kCompleted, 0, static_cast<LPARAM>(hr)); return S_OK;
    }
    STDMETHODIMP OnExecuteFilesInUse(LPCWSTR, DWORD, LPCWSTR*, int, BOOTSTRAPPER_FILES_IN_USE_TYPE, int* result) override { *result = IDCANCEL; return S_OK; }
    STDMETHODIMP OnShutdown(BOOTSTRAPPER_SHUTDOWN_ACTION* action) override {
        // Burn cleanup reuses this instance's successful Detect snapshot. An old
        // canceled wizard must not unregister a present MSI's bundle after a
        // different instance repaired its registration while this one was open.
        bool preserve = exitCode_ == ERROR_INSTALL_USEREXIT && detected_ && installed_ && eligibleCleanup_ && !applyStarted_ && !related_;
        *action = preserve ? BOOTSTRAPPER_SHUTDOWN_ACTION_SKIP_CLEANUP : BOOTSTRAPPER_SHUTDOWN_ACTION_NONE;
        if (preserve && m_pEngine) m_pEngine->Log(BOOTSTRAPPER_LOG_LEVEL_STANDARD, L"Canceled before Apply with an installed package; preserving bundle registration and cache.");
        return S_OK;
    }
    STDMETHODIMP OnDestroy(BOOL) override {
        if (uiThread_) { WaitForSingleObject(uiThread_, INFINITE); CloseHandle(uiThread_); uiThread_ = nullptr; }
        if (artworkIcon_) { DestroyIcon(artworkIcon_); artworkIcon_ = nullptr; }
        if (ready_) { CloseHandle(ready_); ready_ = nullptr; } return S_OK;
    }
};

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR command, int) {
#if defined(BP_BA_SELF_TEST)
    if (command && wcscmp(command, L"--bp-self-test") == 0) {
        for (const std::wstring input : { L"", L"C:\\Unicode 시험\\", L"C:\\a\\\\\"b", L"space and \\\\ trailing\\", L"plain" }) {
            int count = 0; LPWSTR* args = CommandLineToArgvW((L"selftest " + Quote(input)).c_str(), &count);
            bool ok = args && count == 2 && input == args[1]; if (args) LocalFree(args); if (!ok) return 1;
        }
        if (!SameSid(GetCurrentProcess()) || ProcessPath(GetCurrentProcess()).empty() || !EqualPath(L"C:\\Example\\Folder\\", L"c:\\example\\folder")) return 2;
        if (!BlockPetBootstrapper::TestCommandRules()) return 5;
        if (!BlockPetBootstrapper::TestCanceledCleanup()) return 6;
        if (!BlockPetBootstrapper::TestTextMetrics()) return 7;
        if (!BlockPetBootstrapper::TestInteractiveRetry()) return 9;
        if (!BlockPetBootstrapper::TestWebViewPackageState()) return 22;
        if (!BlockPetBootstrapper::TestReplacementPlans()) return 23;
        if (!BlockPetBootstrapper::TestLegacyShortcutMigration()) return 24;
        for (bool managed : { false, true }) for (bool available : { false, true }) {
            if (BlockAppWithoutWebView(L"Application", TRUE, BOOTSTRAPPER_ACTION_STATE_INSTALL, managed, available) != (managed && !available) ||
                BlockAppWithoutWebView(L"Application", TRUE, BOOTSTRAPPER_ACTION_STATE_REPAIR, managed, available) != (managed && !available) ||
                BlockAppWithoutWebView(L"WebView2", TRUE, BOOTSTRAPPER_ACTION_STATE_INSTALL, managed, available) ||
                BlockAppWithoutWebView(L"Application", FALSE, BOOTSTRAPPER_ACTION_STATE_INSTALL, managed, available) ||
                BlockAppWithoutWebView(L"Application", TRUE, BOOTSTRAPPER_ACTION_STATE_UNINSTALL, managed, available)) return 21;
        }
        if (!TestRemovalShortcut()) return 10;
        if (!TestProcessProbe()) return 11;
        if (!MinimumPlatform(19045, 3448, true, PROCESSOR_ARCHITECTURE_AMD64) ||
            !MinimumPlatform(19045, 5000, true, PROCESSOR_ARCHITECTURE_AMD64) ||
            MinimumPlatform(19045, 3447, true, PROCESSOR_ARCHITECTURE_AMD64) ||
            MinimumPlatform(19045, 3448, false, PROCESSOR_ARCHITECTURE_AMD64) ||
            MinimumPlatform(19044, 5000, true, PROCESSOR_ARCHITECTURE_AMD64) ||
            MinimumPlatform(22000, 5000, true, PROCESSOR_ARCHITECTURE_AMD64) ||
            !MinimumPlatform(22621, 2283, true, PROCESSOR_ARCHITECTURE_AMD64) ||
            MinimumPlatform(22621, 2282, true, PROCESSOR_ARCHITECTURE_AMD64) ||
            MinimumPlatform(22621, 2283, false, PROCESSOR_ARCHITECTURE_AMD64) ||
            !MinimumPlatform(22631, 0, false, PROCESSOR_ARCHITECTURE_AMD64) ||
            !MinimumPlatform(26100, 0, false, PROCESSOR_ARCHITECTURE_AMD64) ||
            !MinimumPlatform(26200, 0, false, PROCESSOR_ARCHITECTURE_AMD64) ||
            MinimumPlatform(26100, 0, false, PROCESSOR_ARCHITECTURE_ARM64) ||
            MinimumPlatform(0, 0, false, PROCESSOR_ARCHITECTURE_AMD64)) return 13;
        if (!BlockPetBootstrapper::TestDiskSpace()) return 12;
        int artworkTest = BlockPetBootstrapper::TestArtworkAndRepaint(); if (artworkTest) return artworkTest;
        wchar_t tempDirectory[MAX_PATH]{}, fixture[MAX_PATH]{};
        if (!GetTempPathW(MAX_PATH, tempDirectory) || !GetTempFileNameW(tempDirectory, L"bpw", 0, fixture)) return 3;
        HANDLE file = CreateFileW(fixture, GENERIC_WRITE, 0, nullptr, TRUNCATE_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        DWORD written = 0; const char data[] = "owned shortcut fixture";
        bool ok = file != INVALID_HANDLE_VALUE && WriteFile(file, data, sizeof(data), &written, nullptr) && written == sizeof(data);
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        auto digest = FileHash(fixture);
        ok = ok && !digest.empty() && RemoveOwnedFile(fixture, std::wstring(64, L'0')) && GetFileAttributesW(fixture) != INVALID_FILE_ATTRIBUTES;
        ok = ok && RemoveOwnedFile(fixture, digest) && GetFileAttributesW(fixture) == INVALID_FILE_ATTRIBUTES;
        DeleteFileW(fixture); if (!ok) return 4;
        return 0;
    }
#else
    (void)command;
#endif
    auto* app = new BlockPetBootstrapper();
    HRESULT hr = BootstrapperApplicationRun(app);
    app->Release(); return FAILED(hr) ? static_cast<int>(hr) : 0;
}
