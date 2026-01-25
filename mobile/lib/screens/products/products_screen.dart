import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../config/app_theme.dart';
import '../../services/product_service.dart';
import '../../widgets/product_card.dart';

class ProductsScreen extends StatefulWidget {
  const ProductsScreen({super.key});

  @override
  State<ProductsScreen> createState() => _ProductsScreenState();
}

class _ProductsScreenState extends State<ProductsScreen> {
  final _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<ProductService>().loadProducts();
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('AtFactoryPrice'),
        actions: [
          IconButton(
            icon: const Icon(Icons.filter_list),
            onPressed: () => _showFilterSheet(context),
          ),
        ],
      ),
      body: Column(
        children: [
          // Search Bar
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              controller: _searchController,
              decoration: InputDecoration(
                hintText: 'Search products...',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _searchController.text.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _searchController.clear();
                          context.read<ProductService>().setSearchQuery('');
                        },
                      )
                    : null,
              ),
              onChanged: (value) {
                context.read<ProductService>().setSearchQuery(value);
              },
            ),
          ),
          // Category Chips
          Consumer<ProductService>(
            builder: (context, service, _) {
              if (service.categories.isEmpty) return const SizedBox.shrink();
              return SizedBox(
                height: 44,
                child: ListView.builder(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  itemCount: service.categories.length,
                  itemBuilder: (context, index) {
                    final category = service.categories[index];
                    final isSelected = category == service.selectedCategory;
                    return Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: FilterChip(
                        label: Text(category),
                        selected: isSelected,
                        onSelected: (_) => service.setCategory(category),
                        selectedColor: AppTheme.primaryColor.withOpacity(0.2),
                        checkmarkColor: AppTheme.primaryColor,
                      ),
                    );
                  },
                ),
              );
            },
          ),
          const SizedBox(height: 8),
          // Products Grid
          Expanded(
            child: Consumer<ProductService>(
              builder: (context, service, _) {
                if (service.isLoading) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (service.error != null) {
                  return Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.error_outline, size: 48, color: AppTheme.textHint),
                        const SizedBox(height: 16),
                        Text(service.error!),
                        const SizedBox(height: 16),
                        ElevatedButton(
                          onPressed: () => service.refresh(),
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                  );
                }
                if (service.products.isEmpty) {
                  return const Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.inventory_2_outlined, size: 48, color: AppTheme.textHint),
                        SizedBox(height: 16),
                        Text('No products found'),
                      ],
                    ),
                  );
                }
                return RefreshIndicator(
                  onRefresh: () => service.refresh(),
                  child: GridView.builder(
                    padding: const EdgeInsets.all(16),
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 2,
                      childAspectRatio: 0.7,
                      crossAxisSpacing: 12,
                      mainAxisSpacing: 12,
                    ),
                    itemCount: service.products.length,
                    itemBuilder: (context, index) {
                      return ProductCard(product: service.products[index]);
                    },
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  void _showFilterSheet(BuildContext context) {
    showModalBottomSheet(
      context: context,
      builder: (context) {
        return Consumer<ProductService>(
          builder: (context, service, _) {
            return Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Sort By', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 16),
                  ListTile(
                    title: const Text('Default'),
                    leading: Radio<String>(
                      value: 'default',
                      groupValue: service.sortBy,
                      onChanged: (v) {
                        service.setSortBy(v!);
                        Navigator.pop(context);
                      },
                    ),
                  ),
                  ListTile(
                    title: const Text('Price: Low to High'),
                    leading: Radio<String>(
                      value: 'price_low',
                      groupValue: service.sortBy,
                      onChanged: (v) {
                        service.setSortBy(v!);
                        Navigator.pop(context);
                      },
                    ),
                  ),
                  ListTile(
                    title: const Text('Price: High to Low'),
                    leading: Radio<String>(
                      value: 'price_high',
                      groupValue: service.sortBy,
                      onChanged: (v) {
                        service.setSortBy(v!);
                        Navigator.pop(context);
                      },
                    ),
                  ),
                  ListTile(
                    title: const Text('Best Sellers'),
                    leading: Radio<String>(
                      value: 'bestseller',
                      groupValue: service.sortBy,
                      onChanged: (v) {
                        service.setSortBy(v!);
                        Navigator.pop(context);
                      },
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}
