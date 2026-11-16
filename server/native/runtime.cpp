#include <cstdio>
#include <cstdlib>
#ifdef _WIN32
#include <windows.h>
#endif
#define NOHOOK __attribute__((no_instrument_function))
extern int main();
extern "C" NOHOOK __attribute__((noinline)) void cppide_final_checkpoint() { asm volatile("" ::: "memory"); }
extern "C" NOHOOK void __cyg_profile_func_enter(void*, void*) {}
extern "C" NOHOOK void __cyg_profile_func_exit(void* function, void*) {
    if (function == reinterpret_cast<void*>(&main)) cppide_final_checkpoint();
}
NOHOOK __attribute__((constructor(101))) static void connect_console() {
#ifdef _WIN32
    const char* pid = std::getenv("CPPIDE_CONSOLE_PID");
    if (!pid) return;
    FreeConsole();
    if (!AttachConsole(static_cast<DWORD>(std::strtoul(pid, nullptr, 10)))) return;
    SetConsoleCP(CP_UTF8); SetConsoleOutputCP(CP_UTF8);
    std::freopen("CONIN$", "r", stdin); std::freopen("CONOUT$", "w", stdout); std::freopen("CONOUT$", "w", stderr);
#endif
}
