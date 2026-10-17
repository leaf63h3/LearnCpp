#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "third_party/httplib.h"
#include <windows.h>
#include <shellapi.h>
#include "third_party/json.hpp"
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

using Json = nlohmann::json;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
static const std::string Origin = "http://127.0.0.1:8768";

static std::string readFile(const fs::path& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("Cannot read file.");
    return std::string(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
}

static std::string timestamp() {
    SYSTEMTIME now{};
    GetSystemTime(&now);
    char text[40];
    sprintf_s(text, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds);
    return text;
}

static bool unit(double n) { return std::isfinite(n) && n >= 0 && n <= 1; }

class FolderStore {
    fs::path file_;
    std::mutex mutex_;

    Json read() const {
        Json state = Json::parse(readFile(file_));
        if (!state.is_object() || state.value("version", 0) != 2 || !state.contains("lessons") || !state["lessons"].is_object())
            throw std::runtime_error("Invalid data/state.json. Restore your backup before starting.");
        return state;
    }

    void write(const Json& state) const {
        auto temp = file_;
        temp += L".tmp";
        const std::string bytes = state.dump(2) + "\n";
        HANDLE handle = CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (handle == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot write data/state.json. Check folder permissions.");
        DWORD written = 0;
        bool ok = WriteFile(handle, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size() && FlushFileBuffers(handle);
        CloseHandle(handle);
        if (!ok) { DeleteFileW(temp.c_str()); throw std::runtime_error("Could not finish saving your data."); }
        if (fs::exists(file_)) {
            auto backup = file_; backup += L".bak";
            if (!CopyFileW(file_.c_str(), backup.c_str(), FALSE)) {
                DeleteFileW(temp.c_str()); throw std::runtime_error("Cannot create the reading data backup.");
            }
        }
        if (!MoveFileExW(temp.c_str(), file_.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            DeleteFileW(temp.c_str()); throw std::runtime_error("Cannot replace data/state.json.");
        }
    }

    static Json highlights(const Json& value) {
        if (!value.is_array() || value.size() > 10000) throw std::invalid_argument("Invalid highlights.");
        Json result = Json::array();
        for (const auto& item : value) {
            if (!item.is_object() || !item.contains("start") || !item.contains("end") || !item.contains("quote") ||
                !item["start"].is_number_integer() || !item["end"].is_number_integer() || !item["quote"].is_string())
                throw std::invalid_argument("Invalid highlight range.");
            const auto a = item["start"].get<int64_t>();
            const auto b = item["end"].get<int64_t>();
            const auto quote = item["quote"].get<std::string>();
            const int length = quote.empty() ? 0 : MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, quote.data(), static_cast<int>(quote.size()), nullptr, 0);
            if (a < 0 || b <= a || b > 5000000 || b - a != length) throw std::invalid_argument("Invalid highlight text.");
            result.push_back({{"start", a}, {"end", b}, {"quote", quote}});
        }
        return result;
    }

    static Json progress(const Json& value) {
        if (!value.is_object() || !value.contains("ratio") || !value["ratio"].is_number() || !unit(value["ratio"].get<double>()) ||
            !value.contains("fraction") || !value["fraction"].is_number() || !unit(value["fraction"].get<double>()) ||
            !value.contains("anchor") || !value["anchor"].is_string() || value["anchor"].get<std::string>().size() > 80)
            throw std::invalid_argument("Invalid reading progress.");
        Json sections = value.value("openSections", Json::array());
        if (!sections.is_array() || sections.size() > 1000) throw std::invalid_argument("Invalid sections.");
        for (const auto& section : sections)
            if (!section.is_string() || section.get<std::string>().size() > 200) throw std::invalid_argument("Invalid section.");
        return {{"ratio", value["ratio"]}, {"anchor", value["anchor"]}, {"fraction", value["fraction"]}, {"openSections", sections}};
    }

public:
    explicit FolderStore(const fs::path& root) : file_(root / L"data" / L"state.json") {
        fs::create_directories(file_.parent_path());
        if (!fs::exists(file_)) write({{"version", 2}, {"lastLesson", nullptr}, {"lessons", Json::object()}});
        read();
    }

    Json snapshot() { std::lock_guard<std::mutex> lock(mutex_); return read(); }

    void patch(const std::string& slug, const Json& patch) {
        if (!patch.is_object() || (!patch.contains("highlights") && !patch.contains("progress"))) throw std::invalid_argument("Empty update.");
        Json marks, position;
        if (patch.contains("highlights")) marks = highlights(patch["highlights"]);
        if (patch.contains("progress")) position = progress(patch["progress"]);
        std::lock_guard<std::mutex> lock(mutex_);
        Json state = read();
        Json& lesson = state["lessons"][slug];
        if (marks.is_array()) lesson["highlights"] = std::move(marks);
        if (position.is_object()) { lesson["progress"] = std::move(position); state["lastLesson"] = slug; }
        lesson["updatedAt"] = timestamp();
        write(state);
    }
};

class TabLifetime {
    std::mutex mutex_;
    unsigned tabs_ = 0;
    bool seen_ = false;
    Clock::time_point zero_ = Clock::now();
public:
    void opened() { std::lock_guard<std::mutex> lock(mutex_); ++tabs_; seen_ = true; }
    void closed() { std::lock_guard<std::mutex> lock(mutex_); if (tabs_) --tabs_; if (!tabs_) zero_ = Clock::now(); }
    void navigating() { std::lock_guard<std::mutex> lock(mutex_); if (!tabs_) zero_ = Clock::now(); }
    bool shouldStop() {
        std::lock_guard<std::mutex> lock(mutex_);
        return !tabs_ && Clock::now() - zero_ > (seen_ ? std::chrono::seconds(3) : std::chrono::seconds(90));
    }
};

static std::string folderId(const fs::path& root) {
    uint64_t hash = 14695981039346656037ull;
    for (wchar_t character : root.native()) { hash ^= static_cast<uint64_t>(towlower(character)); hash *= 1099511628211ull; }
    std::ostringstream text; text << std::hex << hash; return text.str();
}

static void jsonReply(httplib::Response& response, const Json& body, int status = 200) {
    response.status = status;
    response.set_content(body.dump(), "application/json; charset=utf-8");
}

static std::string mime(const fs::path& path) {
    const auto ext = path.extension().string();
    if (ext == ".html") return "text/html; charset=utf-8";
    if (ext == ".css") return "text/css; charset=utf-8";
    if (ext == ".js") return "text/javascript; charset=utf-8";
    if (ext == ".json") return "application/json; charset=utf-8";
    if (ext == ".png") return "image/png";
    if (ext == ".gif") return "image/gif";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".webp") return "image/webp";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    return "application/octet-stream";
}

static void openBrowser() {
    auto result = ShellExecuteW(nullptr, L"open", L"http://127.0.0.1:8768/", nullptr, nullptr, SW_SHOWNORMAL);
    if (reinterpret_cast<INT_PTR>(result) <= 32) throw std::runtime_error("Cannot open your browser. Open http://127.0.0.1:8768/ manually.");
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    bool noBrowser = false, quiet = false;
    int count = 0;
    LPWSTR* args = CommandLineToArgvW(GetCommandLineW(), &count);
    if (args) {
        for (int i = 1; i < count; ++i) { noBrowser |= std::wstring(args[i]) == L"--no-browser"; quiet |= std::wstring(args[i]) == L"--quiet-errors"; }
        LocalFree(args);
    }
    try {
        std::wstring executable(32768, L'\0');
        const DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
        if (!length || length >= executable.size()) throw std::runtime_error("Cannot locate LearnCpp.exe.");
        executable.resize(length);
        const fs::path root = fs::path(executable).parent_path();
        const std::string id = folderId(root);
        httplib::Server server;
        server.set_socket_options([](socket_t socket) {
            const int exclusive = 1;
            setsockopt(socket, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof(exclusive));
        });
        if (!server.bind_to_port("127.0.0.1", 8768)) {
            httplib::Client existing(Origin);
            existing.set_connection_timeout(1);
            if (auto response = existing.Get("/api/app")) {
                auto info = Json::parse(response->body, nullptr, false);
                if (info.is_object() && info.value("app", "") == "LearnCpp Native" && info.value("folder", "") == id) {
                    if (!noBrowser) openBrowser();
                    return 0;
                }
            }
            throw std::runtime_error("Port 8768 is already in use. Close the other application or other copy of LearnCpp, then try again.");
        }
        FolderStore store(root);
        TabLifetime lifetime;
        std::atomic<bool> stopping{false};
        server.new_task_queue = [] { return new httplib::ThreadPool(24); };
        server.set_read_timeout(5);
        server.set_write_timeout(5);
        server.set_payload_max_length(2 * 1024 * 1024);
        server.set_default_headers({{"Cache-Control", "no-store"}, {"X-Content-Type-Options", "nosniff"}, {"Referrer-Policy", "no-referrer"}});
        server.set_pre_routing_handler([&](const httplib::Request& request, httplib::Response& response) {
            const auto host = request.get_header_value("Host");
            const auto origin = request.get_header_value("Origin");
            if (host != "127.0.0.1:8768" || (!origin.empty() && origin != Origin)) {
                jsonReply(response, {{"error", "Local access only."}}, 403);
                return httplib::Server::HandlerResponse::Handled;
            }
            if (request.method == "POST" && request.get_header_value("Content-Type").find("application/json") != 0) {
                jsonReply(response, {{"error", "Expected JSON."}}, 400);
                return httplib::Server::HandlerResponse::Handled;
            }
            return httplib::Server::HandlerResponse::Unhandled;
        });
        server.set_exception_handler([](const auto&, auto& response, std::exception_ptr error) {
            try { if (error) std::rethrow_exception(error); }
            catch (const std::invalid_argument&) { jsonReply(response, {{"error", "Invalid update."}}, 400); }
            catch (const Json::exception&) { jsonReply(response, {{"error", "Invalid JSON or reading data."}}, 400); }
            catch (...) { jsonReply(response, {{"error", "Cannot read or save data/state.json. Check folder write access."}}, 500); }
        });
        server.Get("/api/app", [&](const auto&, auto& response) {
            jsonReply(response, {{"app", "LearnCpp Native"}, {"folder", id}, {"pid", GetCurrentProcessId()}});
        });
        server.Get("/api/state", [&](const auto&, auto& response) { jsonReply(response, store.snapshot()); });
        server.Post(R"(/api/lesson/([a-z0-9-]{1,200}))", [&](const auto& request, auto& response) {
            const std::string slug = request.matches[1];
            if (!fs::is_regular_file(root / L"lessons" / fs::u8path(slug + ".html"))) { response.status = 404; return; }
            store.patch(slug, Json::parse(request.body));
            jsonReply(response, {{"ok", true}});
        });
        server.Get("/api/session", [&](const httplib::Request& request, httplib::Response& response) {
            lifetime.opened();
            response.set_chunked_content_provider("text/event-stream", [&, closed = request.is_connection_closed](size_t offset, httplib::DataSink& sink) {
                if (stopping.load() || closed()) return false;
                if (offset) std::this_thread::sleep_for(std::chrono::milliseconds(500));
                static const char event[] = "data: connected\n\n";
                return !stopping.load() && !closed() && sink.write(event, sizeof(event) - 1);
            }, [&](bool) { lifetime.closed(); });
        });
        server.Get(R"(/.*)", [&](const httplib::Request& request, httplib::Response& response) {
            std::string relative = request.path == "/" ? "index.html" : request.path.substr(1);
            if (relative.find("..") != std::string::npos || relative.find('\\') != std::string::npos || relative.find(':') != std::string::npos || relative.find('\0') != std::string::npos ||
                !(relative == "index.html" || relative == "manifest.json" || relative.rfind("assets/", 0) == 0 || relative.rfind("lessons/", 0) == 0)) { response.status = 404; return; }
            const auto file = root / fs::u8path(relative);
            if (!fs::is_regular_file(file)) { response.status = 404; return; }
            if (file.extension() == L".html") lifetime.navigating();
            response.set_content(readFile(file), mime(file));
        });
        std::thread monitor([&] {
            while (!stopping.load()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(200));
                if (lifetime.shouldStop()) { stopping = true; server.stop(); }
            }
        });
        try {
            if (!noBrowser) openBrowser();
            server.listen_after_bind();
        } catch (...) {
            stopping = true;
            server.stop();
            monitor.join();
            throw;
        }
        stopping = true;
        monitor.join();
        return 0;
    } catch (const std::exception& error) {
        if (!quiet) MessageBoxA(nullptr, error.what(), "LearnCpp", MB_OK | MB_ICONERROR);
        return 1;
    }
}
