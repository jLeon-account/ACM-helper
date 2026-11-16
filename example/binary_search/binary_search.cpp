#include <iostream>
using namespace std;

// 查找第一个等于目标的下标；包含重复值、负数和不存在的目标。
const int n = 8;
int a[n] = {-5, -1, 0, 0, 3, 3, 8, 10};
int targets[4] = {3, 2, -8, 99};
int answers[4] = {-1, -1, -1, -1};
int left_bound, right_bound, mid, target;

int main() {
    for (int query = 0; query < 4; ++query) {
        target = targets[query];
        left_bound = 0;
        right_bound = n;
        while (left_bound < right_bound) {
            mid = left_bound + (right_bound - left_bound) / 2;
            if (a[mid] < target) {
                left_bound = mid + 1; // @probe: 下界右移
            } else {
                right_bound = mid;
            }
        }
        answers[query] = left_bound < n && a[left_bound] == target ? left_bound : -1;
    }
    for (int answer : answers) cout << answer << ' ';
    cout << '\n';
    return 0;
}
