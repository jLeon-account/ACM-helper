#include <iostream>
#include <vector>
using namespace std;
vector<int> a = {8, 3, 6, 1, 9, 2, 7, 4};
int main() {
    for (int i = 0; i < (int)a.size(); ++i) {
        for (int j = 0; j + 1 < (int)a.size() - i; ++j) {
            if (a[j] > a[j + 1]) {
                int temp = a[j];
                a[j] = a[j + 1];
                a[j + 1] = temp;
            }
        }
    }
    for (int x : a) cout << x << ' ';
    cout << '\n';
    return 0;
}
