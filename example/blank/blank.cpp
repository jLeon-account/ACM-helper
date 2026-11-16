#include <iostream>
using namespace std;

int main() {
    int a[6] = {3, 1, 4, 1, 5, 9};
    for (int i = 0; i < 6; ++i) {
        a[i] *= 2;
        cout << a[i] << ' ';
    }
    cout << '\n';
    return 0;
}
