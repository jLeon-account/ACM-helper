#include <iostream>
#include <algorithm>
using namespace std;
int a[1000000];
int main() {
    fill(a, a + 1000000, -1);
    a[100] = 5;
    a[500000] = 42;
    a[999999] = 7;
    a[100] = -1;
    for (int i = 200; i < 220; ++i) {
        a[i] = 0;
    }
    cout << a[100] << ' ' << a[500000] << ' ' << a[999999] << '\n';
    return 0;
}
