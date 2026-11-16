#include <iostream>
using namespace std;

int a[8] = {4, -2, 7, 4, 0, -2, 9, 1};

void quick_sort(int left, int right) {
    if (left >= right) return;
    int i = left, j = right;
    int pivot = a[left + (right - left) / 2];
    while (i <= j) {
        while (a[i] < pivot) ++i;
        while (a[j] > pivot) --j;
        if (i <= j) {
            int temporary = a[i];
            a[i] = a[j]; // @probe: 交换的第一步
            a[j] = temporary;
            ++i;
            --j;
        }
    }
    if (left < j) quick_sort(left, j);
    if (i < right) quick_sort(i, right);
}

int main() {
    quick_sort(0, 7);
    for (int value : a) cout << value << ' ';
    cout << '\n';
    return 0;
}
