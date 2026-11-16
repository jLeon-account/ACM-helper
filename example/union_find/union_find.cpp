#include <iostream>
using namespace std;

int n = 7;
int parent[7]; // -1 表示根，用父节点数组观察合并与路径压缩。
int components = 7;
int current = -1;

int find_root(int node) {
    current = node;
    if (parent[node] == -1) return node;
    parent[node] = find_root(parent[node]);
    return parent[node];
}

void unite(int a, int b) {
    int ra = find_root(a);
    int rb = find_root(b);
    if (ra != rb) {
        parent[ra] = rb; // @probe: 合并两个集合
        --components;
    }
}

int main() {
    for (int i = 0; i < n; ++i) parent[i] = -1;
    unite(0, 1);
    unite(1, 2);
    unite(3, 4);
    unite(2, 4);
    find_root(0);
    unite(0, 3); // 重复合并不减少集合数量。
    for (int p : parent) cout << p << ' ';
    cout << '\n' << components << '\n';
    return 0;
}
