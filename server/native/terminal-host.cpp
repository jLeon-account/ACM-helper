#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <string>

struct Pump { HANDLE from, to; };
DWORD WINAPI pump(void* parameter) {
    auto p = *static_cast<Pump*>(parameter); char data[8192]; DWORD read, written;
    while (ReadFile(p.from, data, sizeof(data), &read, nullptr) && read) {
        DWORD offset = 0;
        while (offset < read) {
            if (!WriteFile(p.to, data + offset, read - offset, &written, nullptr)) return 0;
            offset += written;
        }
    }
    return 0;
}
int main(int argc, char** argv) {
    if (argc > 1 && std::string(argv[1]) == "--anchor") {
        SetConsoleCP(CP_UTF8); SetConsoleOutputCP(CP_UTF8);
        Sleep(INFINITE); return 0;
    }
    HANDLE inputRead, inputWrite, outputRead, outputWrite;
    if (!CreatePipe(&inputRead, &inputWrite, nullptr, 0) || !CreatePipe(&outputRead, &outputWrite, nullptr, 0)) return 2;
    HPCON console;
    COORD size{120, 40};
    if (FAILED(CreatePseudoConsole(size, inputRead, outputWrite, 0, &console))) return 3;
    SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    auto attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
    InitializeProcThreadAttributeList(attributes, 1, 0, &bytes);
    UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, sizeof(console), nullptr, nullptr);
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
    wchar_t self[MAX_PATH]; GetModuleFileNameW(nullptr, self, MAX_PATH);
    std::wstring command = L"\"" + std::wstring(self) + L"\" --anchor";
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &child)) return 4;
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)); AssignProcessToJobObject(job, child.hProcess);
    CloseHandle(inputRead); CloseHandle(outputWrite); CloseHandle(child.hThread);
    DeleteProcThreadAttributeList(attributes); HeapFree(GetProcessHeap(), 0, attributes);
    fprintf(stderr, "READY:%lu\n", child.dwProcessId); fflush(stderr);
    Pump output{outputRead, GetStdHandle(STD_OUTPUT_HANDLE)};
    HANDLE outputThread = CreateThread(nullptr, 0, pump, &output, 0, nullptr);
    // Framed stdin keeps resize controls separate from literal terminal input.
    HANDLE source = GetStdHandle(STD_INPUT_HANDLE);
    auto exact = [source](void* buffer, DWORD size) {
        DWORD n; auto p = static_cast<char*>(buffer);
        while (size) { if (!ReadFile(source, p, size, &n, nullptr) || !n) return false; p += n; size -= n; } return true;
    };
    unsigned char header[5];
    while (exact(header, 5)) {
        DWORD count = header[1] | (header[2]<<8) | (header[3]<<16) | (header[4]<<24);
        if (count > 1024*1024) break;
        std::string payload(count, '\0'); if (!exact(payload.data(), count)) break;
        if (header[0] == 1) { DWORD written; WriteFile(inputWrite, payload.data(), count, &written, nullptr); }
        if (header[0] == 2 && count == 4) { COORD next{static_cast<SHORT>((unsigned char)payload[0] | ((unsigned char)payload[1]<<8)),static_cast<SHORT>((unsigned char)payload[2] | ((unsigned char)payload[3]<<8))}; ResizePseudoConsole(console, next); }
    }
    TerminateProcess(child.hProcess, 0); CloseHandle(child.hProcess); CloseHandle(job);
    ClosePseudoConsole(console); CloseHandle(inputWrite); WaitForSingleObject(outputThread, 2000); CloseHandle(outputThread); CloseHandle(outputRead);
    return 0;
}
